/**
 * 5분 주기 작업을 Supabase Cron(pg_cron + pg_net)에 건다 — Vercel Hobby 는 cron 이 하루 1번이라 DB 가 대신 부른다.
 *   APP_URL=https://<배포 주소> npm run db:cron        (DATABASE_URL · CRON_SECRET 은 .env.local)
 * 매 5분 GET <APP_URL>/api/cron/tick 을 Authorization: Bearer <CRON_SECRET> 로 부른다. 몇 번을 돌려도 같은 작업 하나로 남는다.
 * 끄기: SELECT cron.unschedule('sb-tick');
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
const secret = process.env.CRON_SECRET;
const app = (process.env.APP_URL || process.env.TW_APP_URL || "").replace(/\/+$/, "");
if (!url || !secret || !/^https:\/\//.test(app)) throw new Error("DATABASE_URL · CRON_SECRET · APP_URL(https://…) 이 필요합니다");

const sql = postgres(url, { prepare: false, onnotice: () => {}, max: 1 });
await sql`CREATE EXTENSION IF NOT EXISTS pg_cron`;
await sql`CREATE EXTENSION IF NOT EXISTS pg_net`;
// 한 번 실행은 최대 300초(Vercel maxDuration) — 그보다 조금 길게 기다린다.
const command = `SELECT net.http_get(
  url := ${lit(`${app}/api/cron/tick`)},
  headers := jsonb_build_object('Authorization', ${lit(`Bearer ${secret}`)}),
  timeout_milliseconds := 310000)`;
await sql`SELECT cron.schedule('sb-tick', '*/5 * * * *', ${command})`;
const [j] = await sql`SELECT jobid, schedule, active FROM cron.job WHERE jobname = 'sb-tick'`;
console.log(`Supabase Cron 'sb-tick' — ${j.schedule}, active=${j.active} → ${app}/api/cron/tick`);
await sql.end();

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
