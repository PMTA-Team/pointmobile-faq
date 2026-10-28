/**
 * 소급 결과를 DB 에 넣는다 — 사람이 직접 가리고 쓴 초안(JSON)을 업로드 메일함 탭에 올린다. Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-retro-apply.mts <결정.json> [--dry]
 *
 * JSON 모양:
 *   { "skip":   [{ "id": 12, "category": "service_request", "reason": "FOTA 등록 요청" }],
 *     "drafts": [{ "thread_id": 34, "title": "...", "is_troubleshooting": true, "disclosure": "internal",
 *                  "disclosure_reason": "...", "applies_to": "...", "description_html": "<p>…</p>" }] }
 * 초안은 state=draft · origin=backlog(소급) 으로 들어간다 — 담당자 알림 메일은 자동으로 보내지 않는다.
 */
import { readFileSync } from "node:fs";
import { sql } from "../src/server/db.ts";
import { DISCLOSURES, sanitizeHtml } from "../src/server/issuetrack/sb.ts";
import { makeDoc, mark } from "../src/server/mail/triage.ts";

type Draft = { thread_id: number; title: string; is_troubleshooting: boolean; disclosure: string; disclosure_reason: string; applies_to: string; description_html: string };
const j = JSON.parse(readFileSync(process.argv[2], "utf8")) as { skip?: { id: number; category: string; reason: string }[]; drafts?: Draft[] };
const dry = process.argv.includes("--dry");
const RETRO = "소급(직접 작성)";

let skipped = 0, drafted = 0;
for (const s of j.skip ?? []) {
  const [t] = await sql<{ n_messages: number; state: string }[]>`SELECT n_messages, state FROM sb.mail_threads WHERE id = ${s.id}`;
  if (!t || t.state !== "open") continue;
  if (!dry) await mark(s.id, "skipped", s.category, `${RETRO} — ${s.reason}`, t.n_messages);
  skipped++;
}
for (const d of j.drafts ?? []) {
  const [t] = await sql<{ n_messages: number; handler: string; state: string }[]>`SELECT n_messages, handler, state FROM sb.mail_threads WHERE id = ${d.thread_id}`;
  if (!t) { console.warn(`스레드 ${d.thread_id} 없음`); continue; }
  const title = (d.is_troubleshooting && !d.title.startsWith("[TR]") ? "[TR] " : "") + d.title.trim();
  if (dry) { console.log(`초안 ${d.thread_id}: ${title}`); drafted++; continue; }
  const docId = await makeDoc(d.thread_id, t.handler, "draft", "backlog");
  await sql`
    UPDATE sb.rm_sb_docs SET title = ${title}, is_troubleshooting = ${Boolean(d.is_troubleshooting)},
      disclosure = ${d.disclosure in DISCLOSURES ? d.disclosure : "internal"}, disclosure_reason = ${d.disclosure_reason},
      applies_to = ${d.applies_to}, description_html = ${sanitizeHtml(d.description_html)}, model = ${RETRO},
      state = 'draft', error = NULL, generated_at = now()
    WHERE id = ${docId} AND state IN ('backlog', 'queued', 'draft')`;
  await mark(d.thread_id, "candidate", "tech_support", RETRO, t.n_messages);
  drafted++;
}
console.log(`${dry ? "(시험) " : ""}건너뜀 ${skipped} · 초안 ${drafted}`);
await sql.end();
