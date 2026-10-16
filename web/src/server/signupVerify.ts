/**
 * 회원가입 이메일 인증 · ID/이메일 중복 확인.
 *
 * 흐름: 인증번호 받기(sendCode) → 메일의 6자리 입력(verifyCode) → 확인 토큰 → 가입 신청이 토큰을 낸다(consumeToken).
 *  - 인증번호는 원문을 저장하지 않는다 — sha256(비밀 열쇠 · 주소 · 번호). 10분 유효, 틀린 입력 5번이면 무효.
 *  - 재발송은 60초 간격, 한 주소에 한 시간 5번까지.
 *  - 확인 토큰은 30분 유효, 가입 신청에 한 번 쓰면 사라진다.
 *  - 메일은 mailer.sendAsUser 로 나간다 — 검증 모드면 보내지 않고 기록만 한다.
 */
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { EMAIL_RE, ID_RE, likeExact } from "./accounts";
import { sha256 } from "./crypto";
import { sql } from "./db";
import { appUrl, sendAsUser, systemSenderUserId } from "./mailer";
import { signupCodeHtml } from "./mailHtml";
import { render } from "./mailTemplates";

export const CODE_TTL_SEC = 10 * 60;
export const TOKEN_TTL_SEC = 30 * 60;
export const RESEND_GAP_SEC = 60;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const norm = (e: string) => (e || "").trim().toLowerCase();
const h = (...parts: string[]) => sha256([process.env.FERNET_KEY || process.env.SBN_SECRET || "", ...parts].join("\x1f"));

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── 중복 확인 ─────────────────────────────────────────────────────────────────

/** [쓸 수 있나, 안내]. 반려된 ID 는 다시 신청할 수 있으므로 '쓸 수 있음'. */
export async function idStatus(username: string): Promise<[boolean, string]> {
  const u = (username || "").trim();
  if (!ID_RE.test(u)) return [false, "영문·숫자로 시작하는 4~40자(영문 · 숫자 · . _ -)"];
  const [row] = await sql<{ status: string }[]>`SELECT status FROM sb.users WHERE username ILIKE ${likeExact(u)} ORDER BY id LIMIT 1`;
  if (!row || row.status === "rejected") return [true, "사용할 수 있는 ID 입니다"];
  return [false, row.status === "pending" ? "승인을 기다리는 신청이 있는 ID 입니다" : "이미 쓰고 있는 ID 입니다"];
}

/** [쓸 수 있나, 안내]. 승인됐거나 승인 대기 중인 계정의 주소면 쓸 수 없다. */
export async function emailStatus(email: string): Promise<[boolean, string]> {
  const e = norm(email);
  if (!EMAIL_RE.test(e)) return [false, "이메일 형식이 아닙니다"];
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM sb.users WHERE email ILIKE ${likeExact(e)} AND status IN ('approved', 'pending')
    ORDER BY (status <> 'approved') LIMIT 1`;
  if (!row) return [true, "사용할 수 있는 이메일입니다"];
  return [false, row.status === "approved" ? "이미 가입된 이메일입니다" : "승인을 기다리는 신청에 쓰인 이메일입니다"];
}

// ── 인증번호 ───────────────────────────────────────────────────────────────────

type CodeRow = {
  code_hash: string; expires_at: Date | null; attempts: number; sent_at: Date | null;
  sent_count: number; window_start: Date | null; verified_at: Date | null; token_hash: string;
};

/** 인증번호를 만들어 메일로 보낸다. [성공, 안내] */
export async function sendCode(email: string): Promise<[boolean, string]> {
  const e = norm(email);
  const [ok, why] = await emailStatus(e);
  if (!ok) return [false, why];
  const now = Date.now();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const [row] = await sql<CodeRow[]>`SELECT * FROM sb.signup_email_codes WHERE email = ${e}`;
  if (row?.sent_at && now - row.sent_at.getTime() < RESEND_GAP_SEC * 1000) {
    const left = Math.floor((RESEND_GAP_SEC * 1000 - (now - row.sent_at.getTime())) / 1000) + 1;
    return [false, `${left}초 뒤에 다시 받을 수 있습니다`];
  }
  let windowStart = row?.window_start ?? null, sentCount = row?.sent_count ?? 0;
  if (!windowStart || now - windowStart.getTime() > 3600_000) {
    windowStart = new Date(now);
    sentCount = 0;
  }
  if (sentCount >= MAX_PER_HOUR) return [false, "인증번호를 너무 자주 요청했습니다. 한 시간 뒤에 다시 시도하세요"];
  const nowD = new Date(now), exp = new Date(now + CODE_TTL_SEC * 1000);
  await sql`
    INSERT INTO sb.signup_email_codes (email, code_hash, expires_at, attempts, sent_at, sent_count, window_start, verified_at, token_hash)
    VALUES (${e}, ${h("code", e, code)}, ${exp}, 0, ${nowD}, ${sentCount + 1}, ${windowStart}, NULL, '')
    ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
      sent_at = EXCLUDED.sent_at, sent_count = EXCLUDED.sent_count, window_start = EXCLUDED.window_start,
      verified_at = NULL, token_hash = ''`;

  const sender = await systemSenderUserId();
  if (sender == null) return [false, "메일 발송 계정이 설정되지 않아 보낼 수 없습니다"];
  const mins = `${Math.floor(CODE_TTL_SEC / 60)}분`;
  const [subject, body] = await render("signup_email_code", { 인증번호: code, 유효시간: mins });
  const [sent, err] = await sendAsUser(sender, e, subject, body, { html: signupCodeHtml({ code, minutes: Math.floor(CODE_TTL_SEC / 60), appUrl: appUrl() }) });
  if (!sent) return [false, `인증 메일을 보내지 못했습니다 — ${err}`];
  return [true, `${e} 로 인증번호를 보냈습니다. ${mins} 안에 입력하세요`];
}

/** 인증번호 확인 — 맞으면 [true, 안내, 확인 토큰]. */
export async function verifyCode(email: string, code: string): Promise<[boolean, string, string]> {
  const e = norm(email);
  code = (code || "").trim();
  const [row] = await sql<CodeRow[]>`SELECT * FROM sb.signup_email_codes WHERE email = ${e}`;
  if (!row || !row.code_hash) return [false, "먼저 인증번호를 받으세요", ""];
  if (!row.expires_at || Date.now() > row.expires_at.getTime()) return [false, "인증번호가 만료되었습니다. 다시 받으세요", ""];
  if ((row.attempts || 0) >= MAX_ATTEMPTS) return [false, "틀린 입력이 많아 이 인증번호는 쓸 수 없습니다. 다시 받으세요", ""];
  if (!same(row.code_hash, h("code", e, code))) {
    const attempts = (row.attempts || 0) + 1;
    await sql`UPDATE sb.signup_email_codes SET attempts = ${attempts} WHERE email = ${e}`;
    const left = MAX_ATTEMPTS - attempts;
    return [false, left ? `인증번호가 맞지 않습니다 (남은 시도 ${left}번)` : "인증번호가 맞지 않습니다. 다시 받으세요", ""];
  }
  const token = randomBytes(24).toString("base64url");
  // 한 번 맞힌 번호는 다시 못 쓴다
  await sql`UPDATE sb.signup_email_codes SET verified_at = now(), token_hash = ${h("token", e, token)}, code_hash = '' WHERE email = ${e}`;
  return [true, "이메일이 인증되었습니다", token];
}

/** 가입 신청이 낸 확인 토큰이 그 주소의 것이고 아직 유효한가(소모하지 않는다). */
export async function tokenValid(email: string, token: string): Promise<boolean> {
  const e = norm(email);
  const [row] = await sql<CodeRow[]>`SELECT * FROM sb.signup_email_codes WHERE email = ${e}`;
  return Boolean(row && row.token_hash && token && row.verified_at
    && Date.now() - row.verified_at.getTime() <= TOKEN_TTL_SEC * 1000
    && same(row.token_hash, h("token", e, token)));
}

/** 가입 신청이 성공한 뒤 — 토큰을 지워 다시 못 쓰게 한다. */
export async function consumeToken(email: string): Promise<void> {
  await sql`UPDATE sb.signup_email_codes SET token_hash = '' WHERE email = ${norm(email)}`;
}
