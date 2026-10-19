/**
 * 빌드한 앱(next start)에 대고 주요 화면 · API 를 한 바퀴 돈다. 임시 관리자 계정을 만들고 끝나면 지운다.
 *   node --env-file=.env.local --import tsx scripts/e2e-smoke.mts http://127.0.0.1:3173
 * 메일은 검증 모드(기록만), Claude 는 부르지 않는다.
 */
import postgres from "postgres";
import { hashPassword } from "../src/server/crypto.ts";

const BASE = process.argv[2] || "http://127.0.0.1:3173";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const USER = `e2e_${Date.now()}`;
const PW = "e2e-Passw0rd!";
let cookie = "";
let fails = 0;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, {
    method, redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* 화면(HTML) */ }
  return { status: r.status, json: json as Record<string, unknown> | null, text };
}

function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? ` — ${info}` : ""}`);
  if (!ok) fails++;
}

try {
  await sql`INSERT INTO sb.users (username, password_hash, role, status) VALUES (${USER}, ${hashPassword(PW)}, 'admin', 'approved')`;

  for (const p of ["/login", "/signup", "/faq", "/sb", "/issues", "/stats", "/usage", "/settings", "/settings/shadow", "/settings/claude"]) {
    const r = await call("GET", p);
    check(`화면 ${p}`, r.status === 200, String(r.status));
  }
  check("로그인 전 /api/me 401", (await call("GET", "/api/me")).status === 401);
  check("틀린 비밀번호 401", (await call("POST", "/api/login", { username: USER, password: "x" })).status === 401);
  const li = await call("POST", "/api/login", { username: USER, password: PW });
  check("로그인", li.status === 200 && Boolean(cookie), String(li.status));
  const me = await call("GET", "/api/me");
  check("/api/me", me.status === 200 && me.json?.username === USER && me.json?.live === false, JSON.stringify(me.json));

  const ov = await call("GET", "/api/issues/overview");
  check("이슈 머리말", ov.status === 200 && Number((ov.json?.sync as Record<string, number>)?.issues) > 1000,
        `issues=${(ov.json?.sync as Record<string, number>)?.issues}`);
  const lst = await call("GET", "/api/issues/list?limit=5");
  check("이슈 목록", lst.status === 200 && Array.isArray(lst.json?.rows), `total=${lst.json?.total}`);
  const firstId = (lst.json?.rows as { id: number }[] | undefined)?.[0]?.id;
  if (firstId) {
    const tl = await call("GET", `/api/issues/${firstId}/timeline`);
    check("타임라인", tl.status === 200 && Array.isArray(tl.json?.events), `#${firstId} events=${(tl.json?.events as unknown[])?.length}`);
  }
  const sb = await call("GET", "/api/issues/sb?states=all&limit=5");
  check("SB 목록", sb.status === 200 && Array.isArray(sb.json?.docs) && Boolean(sb.json?.disclosures),
        `total=${sb.json?.total} spent=$${sb.json?.spent_usd}`);
  const st = await call("GET", "/api/issues/stats");
  check("통계", st.status === 200 && Boolean(st.json?.summary), `total=${(st.json?.summary as Record<string, number>)?.total}`);
  check("SB 설정", (await call("GET", "/api/issues/settings")).status === 200);
  const set = await call("GET", "/api/admin/settings");
  check("관리 설정", set.status === 200 && (set.json?.claude as Record<string, unknown>)?.backend === "api",
        `web=${(set.json?.web as { target: string }[])?.map((w) => w.target)}`);
  check("계정 목록", (await call("GET", "/api/admin/accounts")).status === 200);
  check("없앤 설정 화면 404", (await call("GET", "/api/admin/staff")).status === 404);
  check("사용량", (await call("GET", "/api/admin/usage")).status === 200);
  const sh = await call("GET", "/api/shadow");
  check("검증 모드 기록", sh.status === 200 && Array.isArray(sh.json?.writes), `runtime=${JSON.stringify(sh.json?.runtime)}`);
  check("cron 비밀값 없으면 401", (await call("GET", "/api/cron/tick")).status === 401);
  check("cron 틀린 비밀값 401", (await call("GET", "/api/cron/tick", undefined, { authorization: "Bearer nope" })).status === 401);
  check("로그아웃", (await call("POST", "/api/logout")).status === 200);
  cookie = "";
  check("로그아웃 뒤 401", (await call("GET", "/api/me")).status === 401);
} finally {
  await sql`DELETE FROM sb.users WHERE username = ${USER}`;
  await sql.end();
}
console.log(fails ? `\n실패 ${fails}건` : "\n모두 통과");
process.exit(fails ? 1 : 0);
