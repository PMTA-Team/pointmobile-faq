/**
 * 로그인 세션 — 서명된 쿠키(sbn_session, 12시간). 쿠키에는 로그인한 순간의 {id, username, role} 만 있다.
 *
 * 그 뒤 계정이 지워지거나 반려 · 역할 변경되면 쿠키만으로는 모르므로, 계정을 다시 읽어
 * **승인된 계정**인지와 지금 역할을 확인한다. 읽은 값은 30초 기억한다(바꾼 자리에서는 바로 지운다).
 */
import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";
import { sql } from "./db";
import { HttpError } from "./http";
import { forget, memo } from "./memo";

export type SessionUser = { id: number; username: string; role: string };

const COOKIE = "sbn_session";
const MAX_AGE = 60 * 60 * 12;

function secret(): Uint8Array {
  const s = process.env.SBN_SECRET;
  if (!s) throw new Error("SBN_SECRET 가 없습니다 (세션 쿠키 서명 키)");
  return new TextEncoder().encode(s);
}

export async function setSession(u: SessionUser): Promise<void> {
  const token = await new SignJWT({ id: u.id, username: u.username, role: u.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

async function readCookie(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const id = Number(payload.id);
    if (!Number.isFinite(id)) return null;
    return { id, username: String(payload.username ?? ""), role: String(payload.role ?? "user") };
  } catch {
    return null;
  }
}

/** 로그인한 승인 계정. 아니면 401. */
export async function requireUser(): Promise<SessionUser> {
  const u = await readCookie();
  if (!u) throw new HttpError(401, "로그인이 필요합니다");
  // 계정 상태는 30초 기억한다 — 요청마다 DB 에 묻지 않게. 승인 · 역할 · 삭제를 바꾸면 forgetUser() 로 바로 지운다.
  const [row] = await memo(`user:${u.id}`, 30_000, () => sql<{ id: number; username: string; role: string; status: string }[]>`
    SELECT id, username, role, status FROM sb.users WHERE id = ${u.id}`);
  if (!row || row.status !== "approved") {
    await clearSession();
    throw new HttpError(401, "로그인이 필요합니다");
  }
  const now = { id: row.id, username: row.username, role: row.role };
  if (now.role !== u.role || now.username !== u.username) await setSession(now);
  return now;
}

/** 계정을 바꾼 뒤 — 이 인스턴스가 기억한 계정 상태를 지운다. */
export function forgetUser(id?: number): void {
  forget(id ? `user:${id}` : "user:");
}

/** 관리자만. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "admin") throw new HttpError(403, "관리자만 할 수 있습니다");
  return u;
}

export const isAdmin = (u: SessionUser) => u.role === "admin";
