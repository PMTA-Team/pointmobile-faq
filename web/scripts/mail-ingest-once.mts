/**
 * 받은 메일함 수집을 한 번 돌린다(읽기 전용 IMAP → sb.mail_*). Claude 는 부르지 않는다(가리기 · 초안은 cron 이 한다).
 *   node --env-file=.env.local --import tsx scripts/mail-ingest-once.mts [반복 횟수]
 */
import { sql } from "../src/server/db.ts";
import { ingestInbox } from "../src/server/mail/imap.ts";

const rounds = Number(process.argv[2] || 1);
for (let i = 0; i < rounds; i++) {
  const r = await ingestInbox(Date.now() + 100_000);
  console.log(JSON.stringify(r));
  if (r.error || !r.more) break;
}
const [s] = await sql<{ t: number; m: number; open: number; noise: number }[]>`
  SELECT (SELECT count(*)::int FROM sb.mail_threads) t, (SELECT count(*)::int FROM sb.mail_messages) m,
         (SELECT count(*)::int FROM sb.mail_threads WHERE state = 'open') open,
         (SELECT count(*)::int FROM sb.mail_threads WHERE state = 'noise') noise`;
console.log(s);
await sql.end();
