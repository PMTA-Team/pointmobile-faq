/**
 * 스레드 원문 보기 — 지정한 스레드들을 초안 생성과 같은 평문(threadText)으로 찍는다. 읽기 전용, Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-thread-dump.mts <id> [id ...] [--max=20000]
 */
import { sql } from "../src/server/db.ts";
import { threadText } from "../src/server/mail/store.ts";

const max = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) || 20000);
for (const id of process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)) {
  console.log(`\n==================== 스레드 ${id}`);
  console.log(await threadText(id, max));
}
await sql.end();
