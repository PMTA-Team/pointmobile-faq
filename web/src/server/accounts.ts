/**
 * 계정 — 회원가입(승인제) · 역할 · 비밀번호 초기화 · 삭제. 관리자 전용 동작은 라우트에서 막는다.
 *
 * 가입하면 승인 대기(pending)가 되고, 관리자가 승인(approved)해야 로그인할 수 있다. 반려(rejected)된
 * 아이디는 같은 아이디로 다시 신청할 수 있다. 역할은 둘 — user(본인 담당 SB 문서만) · admin(전체 · 설정 · 계정).
 */
import { hashPassword } from "./crypto";
import { sql } from "./db";
import { forget } from "./memo";

/** 관리자가 초기화한 계정의 비밀번호. 첫 로그인에서 바꾸게 한다. */
export const INITIAL_PASSWORD = "1234";

export const VALID_ROLES = ["user", "admin"] as const;
export const ROLE_LABEL: Record<string, string> = { admin: "관리자", user: "담당자" };

export const PENDING = "pending", APPROVED = "approved", REJECTED = "rejected";
export const STATUS_LABEL: Record<string, string> = { [PENDING]: "승인 대기", [APPROVED]: "승인", [REJECTED]: "반려" };

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{3,39}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

function checkSignup(company: string, email: string, username: string, password: string, password2: string): string {
  if (!company) return "회사명을 입력하세요.";
  if (!EMAIL_RE.test(email)) return "이메일 형식이 아닙니다.";
  if (!ID_RE.test(username)) return "ID 는 영문·숫자로 시작하는 4~40자(영문 · 숫자 · . _ -)입니다.";
  if (password.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
  if (password !== password2) return "비밀번호 확인이 일치하지 않습니다.";
  if (password === INITIAL_PASSWORD || password.toLowerCase() === username.toLowerCase()) return "아이디나 초기 비밀번호와 다른 비밀번호를 쓰세요.";
  return "";
}

/** ILIKE 로 쓸 때 % _ \ 를 문자 그대로 비교하게 한다. */
export const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * 가입 신청 — 승인 대기 계정을 만든다. [성공, 안내, 계정 id]
 *  · 같은 ID 가 승인 대기면 다시 받지 않는다. · 반려됐으면 새 신청으로 덮는다.
 *  · 승인된 계정과 ID · 이메일이 겹치면 받지 않는다.
 */
export async function requestSignup(
  company: string, email: string, username: string, password: string, password2: string,
): Promise<[boolean, string, number | null]> {
  company = (company || "").trim(); email = (email || "").trim(); username = (username || "").trim();
  const why = checkSignup(company, email, username, password || "", password2 || "");
  if (why) return [false, why, null];
  const [u] = await sql<{ id: number; status: string }[]>`
    SELECT id, status FROM sb.users WHERE username ILIKE ${likeExact(username)} ORDER BY id LIMIT 1`;
  if (u?.status === APPROVED) return [false, "이미 쓰고 있는 ID 입니다.", null];
  if (u?.status === PENDING) return [false, "같은 ID 로 승인을 기다리는 신청이 있습니다. 관리자 승인 후 로그인할 수 있습니다.", null];
  const [clash] = await sql`
    SELECT 1 FROM sb.users WHERE email ILIKE ${likeExact(email)} AND status = 'approved' AND id <> ${u?.id ?? 0} LIMIT 1`;
  if (clash) return [false, "이 이메일로 가입된 계정이 이미 있습니다.", null];
  const hash = hashPassword(password);
  let id: number;
  if (u) {
    await sql`
      UPDATE sb.users SET password_hash = ${hash}, company = ${company}, email = ${email}, status = 'pending',
        must_change_password = false, requested_at = now(), decided_by = '', decided_at = NULL, reject_reason = ''
      WHERE id = ${u.id}`;
    forget(`user:${u.id}`);
    id = u.id;
  } else {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO sb.users (username, password_hash, role, company, email, status, must_change_password, requested_at)
      VALUES (${username}, ${hash}, 'user', ${company}, ${email}, 'pending', false, now()) RETURNING id`;
    id = r.id;
  }
  return [true, "가입 신청을 받았습니다. 관리자가 승인하면 로그인할 수 있습니다.", id];
}

export type SignupInfo = { username: string; company: string; email: string; reason: string };

/** 승인 대기 계정을 승인 · 반려한다. [성공, 안내, 알림에 쓸 신청 정보] */
export async function decideSignup(userId: number, approve: boolean, by: string, reason = ""): Promise<[boolean, string, SignupInfo | null]> {
  reason = (reason || "").trim();
  if (!approve && !reason) return [false, "반려 사유를 적으세요.", null];
  const [u] = await sql<{ username: string; status: string; company: string; email: string }[]>`
    SELECT username, status, company, email FROM sb.users WHERE id = ${userId}`;
  if (!u) return [false, "계정을 찾을 수 없습니다.", null];
  if (u.status !== PENDING) return [false, `'${u.username}' 은(는) 승인 대기가 아닙니다(${STATUS_LABEL[u.status] ?? u.status}).`, null];
  const status = approve ? APPROVED : REJECTED;
  const rr = approve ? "" : reason;
  await sql`UPDATE sb.users SET status = ${status}, decided_by = ${by}, decided_at = now(), reject_reason = ${rr} WHERE id = ${userId}`;
  forget(`user:${userId}`);
  return [true, `'${u.username}' 가입을 ${approve ? "승인" : "반려"}했습니다.`, { username: u.username, company: u.company, email: u.email, reason: rr }];
}

export async function pendingCount(): Promise<number> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sb.users WHERE status = 'pending'`;
  return r.n;
}

/** 비밀번호를 초기값으로 되돌리고 다음 로그인에서 바꾸게 한다. [성공, 안내, 아이디] */
export async function resetPassword(userId: number): Promise<[boolean, string, string]> {
  const [u] = await sql<{ username: string }[]>`
    UPDATE sb.users SET password_hash = ${hashPassword(INITIAL_PASSWORD)}, must_change_password = true
    WHERE id = ${userId} RETURNING username`;
  if (!u) return [false, "계정을 찾을 수 없습니다.", ""];
  return [true, `'${u.username}' 비밀번호를 초기화했습니다.`, u.username];
}

async function adminCount(excludeId: number): Promise<number> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sb.users WHERE role = 'admin' AND id <> ${excludeId}`;
  return r.n;
}

/** 역할 변경. 마지막 관리자를 낮추는 것은 막는다. */
export async function setUserRole(targetId: number, role: string): Promise<[boolean, string]> {
  if (!(VALID_ROLES as readonly string[]).includes(role)) return [false, `알 수 없는 역할입니다: ${role}`];
  const [u] = await sql<{ username: string; role: string }[]>`SELECT username, role FROM sb.users WHERE id = ${targetId}`;
  if (!u) return [false, "계정을 찾을 수 없습니다."];
  if (u.role === role) return [true, `'${u.username}' 은(는) 이미 ${ROLE_LABEL[role]}입니다.`];
  if (u.role === "admin" && role !== "admin" && (await adminCount(targetId)) === 0)
    return [false, "마지막 관리자는 권한을 낮출 수 없습니다. 다른 관리자를 먼저 지정하세요."];
  await sql`UPDATE sb.users SET role = ${role} WHERE id = ${targetId}`;
  forget(`user:${targetId}`);
  return [true, `'${u.username}' 을(를) ${ROLE_LABEL[role]}(으)로 변경했습니다.`];
}

/** 계정 삭제 — 개인 자격증명은 외래키(ON DELETE CASCADE)로 같이 지워진다. SB 문서 · 이슈는 그대로 남는다. */
export async function deleteUser(targetId: number, actingId: number): Promise<[boolean, string]> {
  if (targetId === actingId) return [false, "본인 계정은 삭제할 수 없습니다."];
  const [u] = await sql<{ username: string; role: string }[]>`SELECT username, role FROM sb.users WHERE id = ${targetId}`;
  if (!u) return [false, "계정을 찾을 수 없습니다."];
  if (u.role === "admin" && (await adminCount(targetId)) === 0) return [false, "마지막 관리자는 삭제할 수 없습니다."];
  await sql`DELETE FROM sb.users WHERE id = ${targetId}`;
  forget(`user:${targetId}`);
  return [true, `'${u.username}' 계정을 삭제했습니다.`];
}
