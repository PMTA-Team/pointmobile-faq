/**
 * 첨부 목록 채우기(한 번) — 첨부 목록을 적기 전에 메일 서버에서 수집한 메일 중, 아직 업로드 문서가 아닌 스레드의 메일에
 * 첨부 목록(파트 번호)을 적는다. 그래야 나중에 문서가 되면 cron 이 첨부를 받아 올린다. 메일 서버는 읽기 전용으로 연다.
 *   node --env-file=.env.local --import tsx scripts/mail-att-backfill.mts
 */
import { ImapFlow } from "imapflow";
import { sql } from "../src/server/db.ts";
import { inboxIdentity } from "../src/server/mailer.ts";
import { filesOf, recordFiles } from "../src/server/mail/attachments.ts";

// 소급 이관으로 들어온 메일은 메일 서버 UID 가 없다 — 서버에 남아 있을 만한 최근 메일(16일)은 Message-ID 로 찾아 UID 를 적는다.
const rows = await sql<{ id: number; thread_id: number; uid: number | null; mid: string }[]>`
  SELECT m.id, m.thread_id, m.imap_uid AS uid, m.message_id AS mid FROM sb.mail_messages m
  WHERE m.noise = '' AND (m.imap_uid IS NOT NULL OR m.sent_at > now() - interval '16 days')
    AND NOT EXISTS (SELECT 1 FROM sb.mail_attachments a WHERE a.message_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM sb.rm_sb_docs d WHERE d.mail_thread_id = m.thread_id AND d.source = 'mail')`;
const id = await inboxIdentity();
if (!id) throw new Error("받은 메일함 계정 없음");
const client = new ImapFlow({ host: id.host, port: 993, secure: true, auth: { user: id.email, pass: id.password }, logger: false });
await client.connect();
const lock = await client.getMailboxLock("INBOX", { readOnly: true });
let n = 0, files = 0;
try {
  for (const r of rows) {
    let uid = r.uid;
    if (!uid) {
      if (!r.mid.startsWith("<")) continue;
      uid = ((await client.search({ header: { "message-id": r.mid } }, { uid: true })) || [])[0] ?? null;
      if (!uid) continue;
      await sql`UPDATE sb.mail_messages SET imap_uid = ${uid} WHERE id = ${r.id}`;
    }
    const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!msg) continue;
    const f = filesOf(msg.bodyStructure);
    if (f.length) { await recordFiles(r.id, r.thread_id, f); files += f.length; }
    n++;
  }
} finally {
  lock.release();
  await client.logout().catch(() => {});
}
console.log(`메일 ${n}통 확인 · 첨부 ${files}개 목록 기록`);
await sql.end();
