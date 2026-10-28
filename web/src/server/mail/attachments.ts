/**
 * 메일 첨부 — 업로드 문서가 된 스레드의 첨부만 Dropbox(<root>/mail/<스레드 id>/<파일>)에 올린다.
 *   · 수집할 때는 파일 목록(이름 · 크기 · IMAP 파트 번호)만 적어 둔다.
 *   · 스레드가 업로드 문서가 되면 cron 이 메일 서버에서 그 파트만 받아(읽기 전용) Dropbox 에 올린다.
 *     메일 서버는 2주 남짓 보관하고 문서는 조용해진 지 3일 뒤에 생기므로 그 안에 받는다.
 *   · 서명 로고 같은 작은 그림(30KB 미만)은 적지도 받지도 않는다.
 * FAQ 에 함께 올릴지는 검토하는 사람이 파일마다 고른다(publish).
 */
import type { ImapFlow, MessageStructureObject } from "imapflow";
import { sql } from "../db";
import { mailPath, upload } from "../dropbox";

export type FileMeta = { filename: string; mediaType: string; size: number; part: string };

const SMALL_IMAGE = 30 * 1024;
const MAX_FILE = 150 * 1024 * 1024;

/** 받을 만한 첨부인가 — 이름이 있고, 작은 그림(서명 · 로고)이 아니다. */
export function keepFile(f: { filename: string; mediaType: string; size: number }): boolean {
  if (!f.filename) return false;
  if (/^image\//i.test(f.mediaType) && f.size < SMALL_IMAGE) return false;
  // Outlook 이 덧붙이는 것(winmail.dat · oledata.mso · ATT00001.htm) · 서명 · 원본 메일 사본(_raw.eml)은 첨부가 아니다
  return !/^(winmail\.dat|smime\.p7s|_raw\.eml|ATT\d+\.html?)$|\.mso$/i.test(f.filename);
}

/** IMAP 본문 구조에서 첨부 파트를 뽑는다. */
export function filesOf(node: MessageStructureObject | undefined): FileMeta[] {
  const out: FileMeta[] = [];
  const walk = (n: MessageStructureObject | undefined) => {
    if (!n) return;
    if (n.childNodes?.length) n.childNodes.forEach(walk);
    const name = n.dispositionParameters?.filename || n.parameters?.name || "";
    if (name && n.part) {
      // 전송 인코딩(base64) 크기를 원래 크기로 어림한다
      const size = Math.round((n.size || 0) * (/base64/i.test(n.encoding || "") ? 0.75 : 1));
      const f = { filename: name, mediaType: n.type || "", size, part: n.part };
      if (keepFile(f)) out.push(f);
    }
  };
  walk(node);
  return out;
}

export async function recordFiles(messageRowId: number, threadId: number, files: FileMeta[]): Promise<void> {
  for (const f of files)
    await sql`
      INSERT INTO sb.mail_attachments (message_id, thread_id, filename, media_type, size, part)
      VALUES (${messageRowId}, ${threadId}, ${f.filename.slice(0, 500)}, ${f.mediaType.slice(0, 200)}, ${f.size}, ${f.part})
      ON CONFLICT DO NOTHING`;
}

/** 파일을 Dropbox 에 올리고 경로를 적는다. 같은 스레드에 같은 이름이 이미 있으면 앞에 메일 id 를 붙인다. */
export async function storeFile(attId: number, data: Uint8Array): Promise<string> {
  const [a] = await sql<{ thread_id: number; message_id: number; filename: string }[]>`
    SELECT thread_id, message_id, filename FROM sb.mail_attachments WHERE id = ${attId}`;
  const [dup] = await sql`
    SELECT 1 FROM sb.mail_attachments WHERE thread_id = ${a.thread_id} AND filename = ${a.filename} AND id <> ${attId} AND storage_path IS NOT NULL`;
  const path = await mailPath(a.thread_id, dup ? `${a.message_id}_${a.filename}` : a.filename);
  await upload(path, data);
  await sql`UPDATE sb.mail_attachments SET storage_path = ${path}, size = ${data.length}, error = NULL WHERE id = ${attId}`;
  return path;
}

/**
 * 업로드 문서가 된 스레드의 아직 안 올린 첨부를 메일 서버에서 받아 올린다(메일함이 읽기 전용으로 열린 client).
 * deadline 전에 멈춘다. 서버에서 지워진 메일은 error 로 남긴다(다시 시도하지 않는다).
 */
export async function uploadPending(client: ImapFlow, deadline: number, limit = 15) {
  const rows = await sql<{ id: number; uid: number; part: string; size: number }[]>`
    SELECT a.id, m.imap_uid AS uid, a.part, a.size FROM sb.mail_attachments a
    JOIN sb.mail_messages m ON m.id = a.message_id
    WHERE a.storage_path IS NULL AND a.error IS NULL AND a.part <> '' AND m.imap_uid IS NOT NULL
      AND EXISTS (SELECT 1 FROM sb.rm_sb_docs d WHERE d.mail_thread_id = a.thread_id AND d.source = 'mail' AND NOT d.superseded)
    ORDER BY a.id LIMIT ${limit}`;
  let uploaded = 0, failed = 0;
  for (const r of rows) {
    if (Date.now() > deadline - 20_000) break;
    // 답장마다 같은 첨부(스크린샷)가 다시 붙는다 — 같은 스레드에 이름 · 크기가 같은 파일을 이미 올렸으면 그것을 가리킨다
    const [same] = await sql<{ storage_path: string }[]>`
      SELECT b.storage_path FROM sb.mail_attachments a JOIN sb.mail_attachments b
        ON b.thread_id = a.thread_id AND b.filename = a.filename AND b.id <> a.id AND b.storage_path IS NOT NULL
        AND abs(b.size - a.size) <= greatest(a.size / 50, 2048)
      WHERE a.id = ${r.id} LIMIT 1`;
    if (same) {
      await sql`UPDATE sb.mail_attachments SET storage_path = ${same.storage_path} WHERE id = ${r.id}`;
      continue;
    }
    if (r.size > MAX_FILE) {
      await sql`UPDATE sb.mail_attachments SET error = '파일이 너무 큼(150MB 초과)' WHERE id = ${r.id}`;
      continue;
    }
    try {
      const d = await client.download(String(r.uid), r.part, { uid: true });
      if (!d.content) {
        await sql`UPDATE sb.mail_attachments SET error = '메일 서버에 원본이 없음' WHERE id = ${r.id}`;
        failed++;
        continue;
      }
      const chunks: Buffer[] = [];
      for await (const c of d.content) chunks.push(c as Buffer);
      await storeFile(r.id, Buffer.concat(chunks));
      uploaded++;
    } catch (e) {
      failed++;
      await sql`UPDATE sb.mail_attachments SET error = ${String(e instanceof Error ? e.message : e).slice(0, 500)} WHERE id = ${r.id}`;
    }
  }
  return { uploaded, failed };
}
