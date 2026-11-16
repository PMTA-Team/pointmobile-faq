/**
 * 스레드 원문 보기 — 지정한 스레드들을 초안 생성과 같은 평문(threadText)으로 찍는다. 읽기 전용, Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-thread-dump.mts <id> [id ...] [--max=20000] [--specifics]
 * --specifics: 원문에서 뽑은 '그대로 옮겨야 할 것'(히든 메뉴 · 코드 · 경로 · 명령 · 버전) 목록도 찍는다.
 */
import { sql } from "../src/server/db.ts";
import { specificsOf } from "../src/server/issuetrack/specifics.ts";
import { threadText } from "../src/server/mail/store.ts";

const max = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) || 20000);
const withSpec = process.argv.includes("--specifics");
for (const id of process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number)) {
  console.log(`\n==================== 스레드 ${id}`);
  const text = await threadText(id, max);
  console.log(text);
  if (withSpec) {
    const items = specificsOf(text);
    console.log(`\n---- 원문에서 뽑은 '그대로 옮겨야 할 것' ${items.length}개`);
    for (const x of items) console.log(`- (${x.kind}) ${x.text}`);
  }
}
await sql.end();
