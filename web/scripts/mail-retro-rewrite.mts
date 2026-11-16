/**
 * 메일 초안 다시 쓰기 — 사람이 직접 다시 쓴 초안(JSON)을 새 판(revision + 1)으로 넣고, 예전 판은 이력으로 남긴다(superseded).
 * 초안 · 검토 요청 상태인 것만 바꾼다(확정 · 폐기된 것은 건드리지 않는다). Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-retro-rewrite.mts <다시쓴.json> [--dry]
 * JSON 모양: { "drafts": [{ "thread_id": 34, "title": "...", "is_troubleshooting": true, "disclosure": "internal",
 *                           "disclosure_reason": "...", "applies_to": "...", "description_html": "<p>…</p>" }] }
 */
import { readFileSync } from "node:fs";
import { sql } from "../src/server/db.ts";
import { DISCLOSURES, sanitizeHtml } from "../src/server/issuetrack/sb.ts";

type Draft = { thread_id: number; title: string; is_troubleshooting: boolean; disclosure: string; disclosure_reason: string; applies_to: string; description_html: string };
const j = JSON.parse(readFileSync(process.argv[2], "utf8")) as { drafts: Draft[] };
const dry = process.argv.includes("--dry");
let done = 0, skipped = 0;
for (const d of j.drafts) {
  const [cur] = await sql<{ id: number; revision: number; state: string; origin: string; assignee_name: string | null; assignee_email: string | null; source_resolved_at: Date | null }[]>`
    SELECT id, revision, state, origin, assignee_name, assignee_email, source_resolved_at FROM sb.rm_sb_docs
    WHERE mail_thread_id = ${d.thread_id} AND source = 'mail' AND NOT superseded ORDER BY revision DESC LIMIT 1`;
  if (!cur || !["draft", "notified"].includes(cur.state)) { skipped++; continue; }
  const title = (d.is_troubleshooting && !d.title.startsWith("[TR]") ? "[TR] " : "") + d.title.trim();
  if (dry) { console.log(`${d.thread_id}: ${title}`); done++; continue; }
  await sql.begin(async (tx) => {
    await tx`UPDATE sb.rm_sb_docs SET superseded = true WHERE id = ${cur.id}`;
    await tx`
      INSERT INTO sb.rm_sb_docs (issue_id, source, mail_thread_id, revision, state, origin, source_resolved_at, title, is_troubleshooting,
        disclosure, disclosure_reason, applies_to, description_html, assignee_name, assignee_email, model, created_at, generated_at)
      VALUES (NULL, 'mail', ${d.thread_id}, ${cur.revision + 1}, 'draft', ${cur.origin}, ${cur.source_resolved_at}, ${title},
        ${Boolean(d.is_troubleshooting)}, ${d.disclosure in DISCLOSURES ? d.disclosure : "internal"}, ${d.disclosure_reason},
        ${d.applies_to}, ${sanitizeHtml(d.description_html)}, ${cur.assignee_name}, ${cur.assignee_email}, '다시 정리(직접 작성)', now(), now())`;
  });
  done++;
}
console.log(`${dry ? "(시험) " : ""}다시 씀 ${done} · 건너뜀 ${skipped}`);
await sql.end();
