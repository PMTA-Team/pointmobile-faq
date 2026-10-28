/**
 * 첨부 소급 2 · 3단계 — 업로드 문서가 된 메일 스레드의 첨부를 Dropbox(<root>/mail/<스레드>/<파일>)에 올린다. Claude 호출 없음.
 *   fetch  : Outlook 에 없던 메일을 메일 서버(IMAP, 읽기 전용)와 tw-automation-v2 가 저장해 둔 첨부 폴더에서 찾아 임시 폴더에 받는다.
 *   upload : 임시 폴더(<dir>/<메일 id>/<파일>)의 파일을 Dropbox 에 올리고 sb.mail_attachments 에 적는다.
 *   node --env-file=.env.local [--env-file=<tw>/backend/.env] --import tsx scripts/mail-att-retro.mts fetch <dir> <not_in_outlook.json>
 *   node --env-file=.env.local --import tsx scripts/mail-att-retro.mts upload <dir>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ImapFlow } from "imapflow";
import postgres from "postgres";
import { sql } from "../src/server/db.ts";
import { inboxIdentity } from "../src/server/mailer.ts";
import { filesOf, keepFile, storeFile } from "../src/server/mail/attachments.ts";

const [mode, dir, listFile] = process.argv.slice(2);
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".pdf": "application/pdf",
  ".zip": "application/zip", ".7z": "application/x-7z-compressed", ".txt": "text/plain", ".log": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv", ".mp4": "video/mp4", ".apk": "application/vnd.android.package-archive", ".msg": "application/vnd.ms-outlook",
};

if (mode === "fetch") {
  const ids: number[] = JSON.parse(readFileSync(listFile, "utf8").replace(/^\uFEFF/, ""));
  const rows = await sql<{ id: number; mid: string }[]>`SELECT id, message_id AS mid FROM sb.mail_messages WHERE id = ANY(${ids}::int[])`;
  const left = new Map(rows.map((r) => [r.id, r.mid]));
  let imapMsgs = 0, imapFiles = 0;

  // ① 메일 서버 — Message-ID 로 찾는다(읽기 전용으로 연다)
  const idn = await inboxIdentity();
  if (idn) {
    const client = new ImapFlow({ host: idn.host, port: 993, secure: true, auth: { user: idn.email, pass: idn.password }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      for (const [id, mid] of [...left]) {
        if (!mid.startsWith("<")) continue;
        const uids = (await client.search({ header: { "message-id": mid } }, { uid: true })) || [];
        if (!uids.length) continue;
        const msg = await client.fetchOne(String(uids[0]), { uid: true, bodyStructure: true }, { uid: true });
        if (!msg) continue;
        imapMsgs++;
        left.delete(id);
        for (const f of filesOf(msg.bodyStructure)) {
          const d = await client.download(String(uids[0]), f.part, { uid: true });
          if (!d.content) continue;
          const chunks: Buffer[] = [];
          for await (const c of d.content) chunks.push(c as Buffer);
          mkdirSync(join(dir, String(id)), { recursive: true });
          writeFileSync(join(dir, String(id), safe(f.filename)), Buffer.concat(chunks));
          imapFiles++;
        }
      }
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }
  }

  // ② tw-automation-v2 가 저장해 둔 첨부 폴더(07월 초 메일 일부)
  let twFiles = 0;
  if (process.env.TWN_PG_URL && left.size) {
    const tw = postgres(process.env.TWN_PG_URL, { prepare: false, max: 1 });
    await tw`SET default_transaction_read_only = on`;
    const base = "C:/Users/POINTMOBILE/dev/tw-automation-v2/backend";
    const dirs = await tw<{ message_id: string; attachment_dir: string }[]>`
      SELECT message_id, attachment_dir FROM public.cached_mails WHERE message_id = ANY(${[...left.values()]}::text[]) AND attachment_dir <> ''`;
    await tw.end();
    const byMid = new Map([...left].map(([id, mid]) => [mid, id]));
    for (const d of dirs) {
      const p = /^[A-Za-z]:|^\//.test(d.attachment_dir) ? d.attachment_dir : join(base, d.attachment_dir);
      const id = byMid.get(d.message_id);
      if (!id || !existsSync(p)) continue;
      for (const f of readdirSync(p)) {
        const full = join(p, f);
        const st = statSync(full);
        if (!st.isFile() || !keepFile({ filename: f, mediaType: MIME[extname(f).toLowerCase()] ?? "", size: st.size })) continue;
        mkdirSync(join(dir, String(id)), { recursive: true });
        writeFileSync(join(dir, String(id), safe(f)), readFileSync(full));
        twFiles++;
      }
      left.delete(id);
    }
  }
  console.log(JSON.stringify({ imap_mails: imapMsgs, imap_files: imapFiles, tw_files: twFiles, not_found: left.size }));
}

if (mode === "upload") {
  let up = 0, skip = 0, fail = 0, dup = 0, bytes = 0;
  // 답장마다 같은 스크린샷이 다시 붙는다 — 한 스레드에서 내용이 같은 파일은 한 번만 올린다
  const seen = new Map<number, Set<string>>();
  for (const r of await sql<{ thread_id: number; size: number; filename: string }[]>`
    SELECT thread_id, size, filename FROM sb.mail_attachments WHERE storage_path IS NOT NULL`)
    (seen.get(r.thread_id) ?? seen.set(r.thread_id, new Set()).get(r.thread_id)!).add(`name:${r.filename}:${r.size}`);
  for (const sub of readdirSync(dir)) {
    if (!/^\d+$/.test(sub)) continue;
    const id = Number(sub);
    const [m] = await sql<{ thread_id: number }[]>`SELECT thread_id FROM sb.mail_messages WHERE id = ${id}`;
    if (!m) continue;
    for (const f of readdirSync(join(dir, sub))) {
      const full = join(dir, sub, f);
      const data = readFileSync(full);
      const media = MIME[extname(f).toLowerCase()] ?? "application/octet-stream";
      if (!keepFile({ filename: f, mediaType: media, size: data.length })) { skip++; continue; }
      const hash = createHash("sha1").update(data).digest("hex");
      const set = seen.get(m.thread_id) ?? seen.set(m.thread_id, new Set()).get(m.thread_id)!;
      if (set.has(hash) || set.has(`name:${f}:${data.length}`)) { dup++; continue; }
      set.add(hash);
      const [row] = await sql<{ id: number; storage_path: string | null }[]>`
        INSERT INTO sb.mail_attachments (message_id, thread_id, filename, media_type, size, part)
        VALUES (${id}, ${m.thread_id}, ${f}, ${media}, ${data.length}, '')
        ON CONFLICT (message_id, filename, part) DO UPDATE SET size = EXCLUDED.size
        RETURNING id, storage_path`;
      if (row.storage_path) { skip++; continue; }
      try {
        await storeFile(row.id, data);
        up++; bytes += data.length;
      } catch (e) {
        fail++;
        await sql`UPDATE sb.mail_attachments SET error = ${String(e).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }
  }
  console.log(JSON.stringify({ uploaded: up, skipped: skip, duplicate: dup, failed: fail, mb: Math.round(bytes / 1e6) }));
}
await sql.end();
