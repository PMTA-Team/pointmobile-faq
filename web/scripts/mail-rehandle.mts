/**
 * 메일 스레드의 담당(handler)을 다시 계산하고, 아직 사람이 손대지 않은 메일 문서(초안 · 생성 대기)의 담당자를 맞춘다.
 * 담당 규칙을 바꾼 뒤 한 번 돌린다. Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-rehandle.mts
 */
import { sql } from "../src/server/db.ts";
import { assigneeEmail } from "../src/server/issuetrack/sb.ts";
import { refreshThread } from "../src/server/mail/store.ts";

const ids = (await sql<{ id: number }[]>`SELECT id FROM sb.mail_threads WHERE noise = ''`).map((r) => r.id);
for (const id of ids) await refreshThread(id);
const docs = await sql<{ id: number; handler: string }[]>`
  SELECT d.id, t.handler FROM sb.rm_sb_docs d JOIN sb.mail_threads t ON t.id = d.mail_thread_id
  WHERE d.source = 'mail' AND d.state IN ('backlog', 'queued', 'draft') AND COALESCE(d.assignee_name, '') <> t.handler`;
for (const d of docs)
  await sql`UPDATE sb.rm_sb_docs SET assignee_name = ${d.handler || null}, assignee_email = ${assigneeEmail(d.handler)} WHERE id = ${d.id}`;
console.log(`스레드 ${ids.length}개 다시 계산 · 문서 담당자 ${docs.length}건 바뀜`);
console.log(await sql`SELECT coalesce(assignee_name, '(없음)') a, count(*)::int n FROM sb.rm_sb_docs WHERE source = 'mail' GROUP BY 1 ORDER BY 2 DESC`);
await sql.end();
