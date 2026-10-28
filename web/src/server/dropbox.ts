/**
 * Dropbox — FAQ 첨부 파일 저장소(회사 지원팀 계정, tw-automation 과 같은 계정). 파일은 <root>/attachments/<문서 id>/<파일명>.
 *
 * - 자격증명: sb.dropbox_credentials(앱 키 · 시크릿 · refresh token, Fernet 암호문). 접근 토큰은 refresh 로 받아 잠깐 쓴다.
 * - 내려받기: 공유 링크를 만들지 않는다(외부 공개 X). 볼 때마다 4시간짜리 임시 직링크(get_temporary_link)를 만들어 넘긴다.
 * - Dropbox-API-Arg 헤더는 ASCII 만 받는다 — 한글 파일명은 \uXXXX 로 바꿔 보낸다.
 */
import { decryptSecret } from "./crypto";
import { sql } from "./db";

const SIMPLE_LIMIT = 140 * 1024 * 1024;    // 이보다 크면 업로드 세션(나눠 올리기)
const CHUNK = 100 * 1024 * 1024;

let cache: { token: string; exp: number; root: string } | null = null;

async function auth(): Promise<{ token: string; root: string }> {
  if (cache && cache.exp > Date.now() + 60_000) return cache;
  const [c] = await sql<{ encrypted_app_key: string; encrypted_app_secret: string; encrypted_refresh_token: string; root_path: string }[]>`
    SELECT encrypted_app_key, encrypted_app_secret, encrypted_refresh_token, root_path FROM sb.dropbox_credentials WHERE id = 1`;
  if (!c) throw new Error("Dropbox 자격증명이 없습니다(sb.dropbox_credentials)");
  const r = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${decryptSecret(c.encrypted_app_key)}:${decryptSecret(c.encrypted_app_secret)}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: decryptSecret(c.encrypted_refresh_token) }),
  });
  if (!r.ok) throw new Error(`Dropbox 인증 실패(${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 14400) * 1000, root: c.root_path.replace(/\/+$/, "") };
  return cache;
}

/** Dropbox-API-Arg 용 JSON — ASCII 밖의 글자는 \uXXXX 로. */
const headerJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));

async function rpc<T>(endpoint: string, body: unknown): Promise<T> {
  const { token } = await auth();
  const r = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Dropbox ${endpoint} 실패(${r.status}): ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

async function content<T>(endpoint: string, arg: unknown, data: Uint8Array): Promise<T> {
  const { token } = await auth();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://content.dropboxapi.com/2/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": headerJson(arg), "Content-Type": "application/octet-stream" },
      body: new Blob([data as Uint8Array<ArrayBuffer>]),
    });
    if (r.ok) return (await r.json().catch(() => ({}))) as T;
    // 속도 제한 · 일시 오류는 잠깐 쉬었다 다시
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Number(r.headers.get("Retry-After") ?? 0) * 1000));
      continue;
    }
    throw new Error(`Dropbox ${endpoint} 실패(${r.status}): ${(await r.text()).slice(0, 300)}`);
  }
}

/** Dropbox 이름에 못 쓰는 글자를 바꾼다. */
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";

/** 첨부 경로 — <root>/attachments/<문서 id>/<파일명> */
export async function attachmentPath(articleId: number, filename: string): Promise<string> {
  const { root } = await auth();
  return `${root}/attachments/${articleId}/${safeName(filename)}`;
}

/** 메일 첨부 경로 — <root>/mail/<스레드 id>/<파일명>. 같은 이름이 있으면 앞에 메일 id 를 붙인다(호출부가 정한다). */
export async function mailPath(threadId: number, filename: string): Promise<string> {
  const { root } = await auth();
  return `${root}/mail/${threadId}/${safeName(filename)}`;
}

/** 올린다(같은 경로면 덮어쓴다). 큰 파일은 나눠 올린다. */
export async function upload(path: string, data: Uint8Array): Promise<void> {
  if (data.length <= SIMPLE_LIMIT) {
    await content("files/upload", { path, mode: "overwrite", mute: true }, data);
    return;
  }
  const start = await content<{ session_id: string }>("files/upload_session/start", { close: false }, data.subarray(0, CHUNK));
  let offset = CHUNK;
  while (data.length - offset > CHUNK) {
    await content("files/upload_session/append_v2", { cursor: { session_id: start.session_id, offset }, close: false },
      data.subarray(offset, offset + CHUNK));
    offset += CHUNK;
  }
  await content("files/upload_session/finish",
    { cursor: { session_id: start.session_id, offset }, commit: { path, mode: "overwrite", mute: true } }, data.subarray(offset));
}

/** 계정 사용량(바이트) — 큰 소급 전에 남은 공간을 본다. */
export async function spaceUsage(): Promise<{ used: number; allocated: number }> {
  const r = await rpc<{ used: number; allocation: { allocated?: number } }>("users/get_space_usage", null);
  return { used: r.used, allocated: r.allocation?.allocated ?? 0 };
}

/** 4시간짜리 임시 직링크 — 로그인한 사람에게만 이 주소로 보낸다. */
export async function temporaryLink(path: string): Promise<string> {
  return (await rpc<{ link: string }>("files/get_temporary_link", { path })).link;
}
