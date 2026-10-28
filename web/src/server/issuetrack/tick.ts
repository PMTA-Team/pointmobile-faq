/**
 * 주기 작업 한 번 — Redmine 수집 → (성공하면) SB 대상 판정 → 초안 생성 → 담당자 검토 요청.
 *
 * 예전 앱은 API 프로세스 안의 스레드가 5분마다 돌렸다(runtime.py · sb_tick.py). 서버리스에는 계속 도는
 * 스레드가 없어 cron(/api/cron/tick)이 5분마다 부르고, 한 번에 시간 예산 안에서만 일한다.
 * 수집이 실패하면 SB 판정을 하지 않는다(예전과 같다). 결과는 rm_sync_state 'tick_status' 에 남겨
 * [설정 → 검증 모드] 화면이 읽는다(runtimeStatus).
 */
import { sql } from "../db";
import { withLock } from "../locks";
import { mailTickOnce } from "../mail/tick";
import { kstSecond } from "../time";
import * as SB from "./sb";
import { loadSbSettings } from "./settings";
import { poll, SYNC_LOCK, type PollResult } from "./sync";

const K_TICK = "tick_status";
const K_FAIL = "redmine_fail_streak";

function log(msg: string) {
  console.info(`[sb ${kstSecond()}] ${msg}`);
}

type Status = { started_at: string; loops: Record<string, { ok: boolean; at: string; error?: string }> };

export async function runtimeStatus(): Promise<Status> {
  try {
    const [r] = await sql<{ value: string | null }[]>`SELECT value FROM sb.rm_sync_state WHERE key = ${K_TICK}`;
    if (r?.value) return JSON.parse(r.value) as Status;
  } catch {
    /* 아래로 */
  }
  return { started_at: "", loops: {} };
}

async function saveStatus(name: string, ok: boolean, startedAt: string, error?: string) {
  const s = await runtimeStatus();
  s.started_at = startedAt;
  s.loops[name] = { ok, at: kstSecond(), ...(error ? { error: error.slice(0, 300) } : {}) };
  await sql`
    INSERT INTO sb.rm_sync_state (key, value, updated_at) VALUES (${K_TICK}, ${JSON.stringify(s)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

async function failStreak(delta: "inc" | "reset"): Promise<number> {
  const [r] = await sql<{ value: string | null }[]>`SELECT value FROM sb.rm_sync_state WHERE key = ${K_FAIL}`;
  const prev = Number(r?.value || 0) || 0;
  const next = delta === "inc" ? prev + 1 : 0;
  if (next !== prev)
    await sql`
      INSERT INTO sb.rm_sync_state (key, value, updated_at) VALUES (${K_FAIL}, ${String(next)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return delta === "inc" ? next : prev;
}

/** Redmine 수집 1회. 자격증명 미등록처럼 고쳐질 때까지 계속 실패하는 종류라 로그를 아껴 남긴다. */
export async function redminePollOnce(deadline: number): Promise<PollResult> {
  let res: PollResult;
  try {
    res = await poll(deadline);
  } catch (e) {
    res = { error: e instanceof Error ? e.message : String(e) };
  }
  if (res.error) {
    const n = await failStreak("inc");
    if ([1, 5, 30].includes(n) || n % 60 === 0) log(`Redmine 수집 실패(${n}회 연속): ${res.error}`);
    return res;
  }
  const prev = await failStreak("reset");
  if (prev) log(`Redmine 수집 복구됨 (연속 실패 ${prev}회 후)`);
  if (res.listed !== undefined)
    log(`Redmine 백필: 이슈 ${res.listed}건, 상세 ${res.detail_done}건(실패 ${res.detail_failed}), 이벤트 ${res.journals}건` +
      (res.partial ? ` — 남은 ${res.deferred}건은 다음 주기에` : ""));
  else if (res.detail_done)
    log(`Redmine 갱신: 이슈 ${res.detail_done}건, 이벤트 ${res.journals}건` + (res.deferred ? ` (다음 주기로 이월 ${res.deferred}건)` : ""));
  return res;
}

/** Resolved 감지 → 초안 생성 → 담당자 검토 요청. 감시 시작 전 Resolved 는 backlog 로만 남는다. */
export async function sbTickOnce(deadline: number): Promise<Record<string, unknown>> {
  const cfg = await loadSbSettings();
  let scanned;
  try {
    scanned = await SB.scan();
  } catch (e) {
    log(`SB scan 실패: ${e}`);
    return { error: String(e) };
  }
  const out: Record<string, unknown> = { ...scanned };
  if (scanned.first_run) {
    const s = await SB.summary();
    log(`SB 감시 시작 — 기존 Resolved ${s.backlog}건은 소급 대기(backlog)로 남겨 둡니다. 자동 생성은 지금 이후 해결분부터입니다.`);
  }

  let made: number[] = [];
  if (cfg.sb_auto_generate) {
    try {
      const gen = await SB.generatePending({ limit: cfg.sb_per_tick, deadline });
      Object.assign(out, gen);
      made = gen.generated_ids;
      if (gen.generated) log(`SB 초안 ${gen.generated}건 생성` + (gen.failed ? ` (실패 ${gen.failed}건)` : ""));
    } catch (e) {
      log(`SB 초안 생성 실패: ${e}`);
    }
  }

  if (cfg.sb_auto_notify) {
    // 방금 만든 초안을 곧바로 담당자에게 알린다 — 이 기능의 본줄기다.
    try {
      const res = await SB.notifyMany(made);
      const retry = await SB.notifyPending(cfg.sb_per_tick); // 앞선 주기에 실패해 남은 것도 함께(재시도 그물)
      const sent = res.sent + retry.sent;
      out.notified = sent;
      if (sent) log(`SB 검토 요청 메일 ${sent}건 발송`);
      const err = [...res.errors, ...retry.errors].find(Boolean);
      if (err) log(`SB 알림 발송 실패: ${err}`);
    } catch (e) {
      log(`SB 알림 발송 실패: ${e}`);
    }
  } else if (made.length) {
    log(`SB 초안 ${made.length}건 생성 — 담당자 알림은 꺼져 있습니다 ([설정 → 동작]에서 켜세요)`);
  }
  return out;
}

/**
 * cron 한 번. budgetMs 안에서만 일한다(서버리스 한 번의 실행 시간 한도보다 짧게).
 * 이미 다른 실행이 잡고 있으면(겹친 cron · 수동 수집) 건너뛴다.
 */
export async function tick(budgetMs = 270_000): Promise<Record<string, unknown>> {
  const startedAt = kstSecond();
  const deadline = Date.now() + budgetMs;
  const res = await withLock(SYNC_LOCK, Math.ceil(budgetMs / 1000) + 30, async () => {
    try {
      const polled = await redminePollOnce(deadline - 120_000); // 수집은 메일 · SB 몫을 남기고 멈춘다
      // 받은 메일함은 Redmine 과 따로 돈다(Redmine 이 멈춰도 메일은 모은다).
      const mail = await mailTickOnce(deadline - 60_000).catch((e) => ({ error: String(e) }));
      await saveStatus("mail", !("error" in mail) && !mail.ingest_error, startedAt,
        "error" in mail ? String(mail.error) : mail.ingest_error ? String(mail.ingest_error) : undefined);
      if (polled.error) {
        await saveStatus("redmine_sb", false, startedAt, polled.error);
        return { poll: polled, mail };
      }
      const sb = await sbTickOnce(deadline);
      await saveStatus("redmine_sb", true, startedAt);
      return { poll: polled, mail, sb };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[sb] tick 오류", e);
      await saveStatus("redmine_sb", false, startedAt, msg).catch(() => {});
      return { error: msg };
    }
  });
  return res ?? { skipped: true, reason: "이미 수집 중입니다" };
}
