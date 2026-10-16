/** 운영 FAQ 검색 · 문서 응답 시간 — 임시 계정으로 로그인해 재고 지운다. */
import postgres from "postgres";
import { hashPassword } from "../src/server/crypto.ts";

const BASE = process.argv[2] || "https://pointmobile-faq.vercel.app";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1, connect_timeout: 20 });
const USER = `latency_${Date.now()}`, PW = `lt-${Math.random().toString(36).slice(2)}A1`;
const T = () => AbortSignal.timeout(30_000);
try {
  console.log("임시 계정 만드는 중");
  await sql`INSERT INTO sb.users (username, password_hash, role, status) VALUES (${USER}, ${hashPassword(PW)}, 'user', 'approved')`;
  console.log("로그인 중");
  const li = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: USER, password: PW }), signal: T(),
  });
  const cookie = (li.headers.get("set-cookie") ?? "").split(";")[0];
  const region = (li.headers.get("x-vercel-id") ?? "").split("::").slice(0, 2).join("→");
  console.log(`로그인 ${li.status} · 함수 지역 ${region}`);
  const times: Record<string, number[]> = {};
  for (const q of ["배터리", "스캐너", "factory reset", "Wi-Fi 연결", "PM85", "bug report", "FRP", "충전"]) {
    for (const [name, path] of [["검색", `/api/faq?q=${encodeURIComponent(q)}`], ["문서", "/api/faq/10"]] as const) {
      const t0 = performance.now();
      const r = await fetch(BASE + path, { headers: { cookie }, signal: T() });
      await r.arrayBuffer();
      (times[name] ??= []).push(performance.now() - t0);
    }
  }
  const stat = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return `중앙값 ${Math.round(s[s.length >> 1])}ms · 최소 ${Math.round(s[0])} · 최대 ${Math.round(s.at(-1)!)}`; };
  for (const [k, v] of Object.entries(times)) console.log(`  ${k} ${v.length}회: ${stat(v)}`);
} finally {
  await sql`DELETE FROM sb.users WHERE username = ${USER}`;
  await sql.end();
}
