/**
 * 소급 — tw-automation-v2 가 같은 받은 메일함에서 모아 둔 메일(cached_mails, 2026-07-13~)을 sb.mail_* 로 옮긴다.
 * 읽기 전용으로 tw-automation-v2 DB(TWN_PG_URL)를 읽는다. Claude 는 부르지 않는다. 몇 번을 돌려도 된다(Message-ID 로 중복 건너뜀).
 *   node --env-file=.env.local --env-file=<tw-automation-v2>/backend/.env --import tsx scripts/mail-import-cached.mts
 */
import postgres from "postgres";
import { htmlToText } from "../src/server/kb/text.ts";
import { sql } from "../src/server/db.ts";
import { saveMail } from "../src/server/mail/store.ts";

const tw = postgres(process.env.TWN_PG_URL!, { prepare: false, max: 1 });
await tw`SET default_transaction_read_only = on`;
type Row = {
  id: number; message_id: string; in_reply_to: string; refs: string; sender: string; subject: string; received_at: string;
  body_text: string; body_html: string; to_recipients: string; cc_recipients: string; attachment_names: string;
};
const rows = await tw<Row[]>`
  SELECT id, message_id, in_reply_to, refs, sender, subject, received_at, body_text, body_html, to_recipients, cc_recipients, attachment_names
  FROM public.cached_mails`;
await tw.end();

const parsed = rows.map((r) => {
  const d = new Date(r.received_at);
  return { r, at: Number.isNaN(d.getTime()) ? null : d };
}).sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

function names(v: string): string[] {
  if (!v) return [];
  try {
    const j = JSON.parse(v);
    if (Array.isArray(j)) return j.map(String).filter(Boolean);
  } catch { /* 쉼표 구분 */ }
  return v.split(/[,;]\s*/).filter(Boolean);
}

let saved = 0, skipped = 0;
const t0 = Date.now();
for (const [i, { r, at }] of parsed.entries()) {
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(r.sender || "");
  const id = await saveMail({
    messageId: r.message_id || `<cached-${r.id}@tw-automation>`,
    inReplyTo: r.in_reply_to || "",
    refs: (r.refs || "").replace(/\s+/g, " "),
    from: (m ? m[2] : r.sender || "").trim(),
    fromName: (m ? m[1] : "").replace(/^"|"$/g, "").trim(),
    to: r.to_recipients || "",
    cc: r.cc_recipients || "",
    subject: r.subject || "",
    sentAt: at,
    text: r.body_text?.trim() ? r.body_text : htmlToText(r.body_html || ""),
    attachments: names(r.attachment_names),
  });
  if (id === null) skipped++; else saved++;
  if ((i + 1) % 500 === 0) console.log(`${i + 1}/${parsed.length} 저장 ${saved} 건너뜀 ${skipped} (${Math.round((Date.now() - t0) / 1000)}초)`);
}
const [s] = await sql<{ t: number; m: number; open: number }[]>`
  SELECT (SELECT count(*)::int FROM sb.mail_threads) t, (SELECT count(*)::int FROM sb.mail_messages) m,
         (SELECT count(*)::int FROM sb.mail_threads WHERE state = 'open') open`;
console.log(`끝 — 저장 ${saved}, 건너뜀 ${skipped}`, s);
await sql.end();
