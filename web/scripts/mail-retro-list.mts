/**
 * 소급 가리기용 — 아직 가리지 않은(open) 스레드 목록을 TSV 로 쓴다(사람이 읽고 가린다). 읽기 전용, Claude 호출 없음.
 *   node --env-file=.env.local --import tsx scripts/mail-retro-list.mts <출력.tsv>
 * 열: 스레드 id · 첫 메일 날짜 · 메일 수 · 우리 쪽 답장 수 · 외부 도메인 · 담당 · 제목
 */
import { writeFileSync } from "node:fs";
import { sql } from "../src/server/db.ts";

const rows = await sql<{ id: number; first_at: Date | null; last_at: Date | null; n: number; ours: number; ext: string[] | null; handler: string; subject: string }[]>`
  SELECT t.id, t.first_at, t.last_at, t.n_messages AS n, t.handler, t.subject,
    (SELECT count(*)::int FROM sb.mail_messages m WHERE m.thread_id = t.id AND m.noise = '' AND m.from_addr LIKE '%@pointmobile.com') AS ours,
    (SELECT array_agg(DISTINCT split_part(m.from_addr, '@', 2)) FROM sb.mail_messages m
      WHERE m.thread_id = t.id AND m.from_addr NOT LIKE '%@pointmobile.com') AS ext
  FROM sb.mail_threads t WHERE t.state = 'open' AND t.noise = '' ORDER BY t.first_at NULLS FIRST, t.id`;
const lines = rows.map((r) =>
  [r.id, r.first_at?.toISOString().slice(0, 10) ?? "", r.n, r.ours, (r.ext ?? []).join(","), r.handler || "-", r.subject.replace(/\s+/g, " ").slice(0, 100)].join("\t"));
writeFileSync(process.argv[2], lines.join("\n"));
console.log(`open 스레드 ${rows.length}개, 우리 답장 없는 것 ${rows.filter((r) => !r.ours).length}개`);
await sql.end();
