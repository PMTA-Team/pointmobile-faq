/**
 * 메일함 주기 작업 — 받은 메일함 수집 → 조용해진 스레드 가리기(감이면 업로드 문서 queued).
 * 초안 생성 · 담당자 알림은 Redmine 과 같은 SB 흐름(sbTickOnce)이 이어서 한다.
 */
import { sql } from "../db";
import { kstSecond } from "../time";
import { ingestInbox } from "./imap";
import { QUIET_DAYS, triagePending } from "./triage";

function log(msg: string) {
  console.info(`[mail ${kstSecond()}] ${msg}`);
}

export async function mailTickOnce(deadline: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    const r = await ingestInbox(deadline);
    out.ingest = r;
    if (r.error) log(`수집 건너뜀: ${r.error}`);
    else if (r.saved) log(`받은 메일 ${r.saved}통 저장 (읽은 ${r.fetched}통${r.more ? ", 남은 것은 다음 주기에" : ""})`);
  } catch (e) {
    out.ingest_error = e instanceof Error ? e.message : String(e);
    log(`수집 실패: ${out.ingest_error}`);
  }
  try {
    const t = await triagePending({ limit: 10, deadline });
    out.triage = t;
    if (t.triaged) log(`스레드 ${t.triaged}개 가림 — 초안 대상 ${t.candidates}개`);
  } catch (e) {
    log(`가리기 실패: ${e}`);
  }
  return out;
}

/** 메일함 탭 머리에 보일 숫자 — 스레드 상태별 개수와 마지막 수집 시각. */
export async function mailSummary() {
  const rows = await sql<{ state: string; n: number }[]>`SELECT state, count(*)::int AS n FROM sb.mail_threads GROUP BY state`;
  const by = Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
  const [w] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sb.mail_threads
    WHERE state = 'open' AND noise = '' AND last_at >= now() - make_interval(days => ${QUIET_DAYS})`;
  const [last] = await sql<{ at: Date | null }[]>`SELECT max(created_at) AS at FROM sb.mail_messages`;
  return {
    threads: Object.values(by).reduce((a, b) => a + b, 0),
    open: by.open ?? 0,
    waiting: w?.n ?? 0,                 // 아직 메일이 오가는 중(조용해지면 가린다)
    candidate: by.candidate ?? 0,
    skipped: by.skipped ?? 0,
    noise: by.noise ?? 0,
    quiet_days: QUIET_DAYS,
    last_saved_at: last?.at ? last.at.toISOString() : null,
  };
}
