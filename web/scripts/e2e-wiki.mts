/** LLM Wiki — Claude 없이 확인할 수 있는 것: 화면 · SSE 흐름(오류 이벤트) · 질문 기록 · 평가. */
import postgres from "postgres";
import { hashPassword } from "../src/server/crypto.ts";

const BASE = process.argv[2] || "http://127.0.0.1:3178";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const USER = `wiki_e2e_${Date.now()}`;
const PW = `e2e-${Math.random().toString(36).slice(2)}A1`;
let cookie = "";
let fails = 0;
const check = (n: string, ok: boolean, info = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${n}${info ? ` — ${info}` : ""}`); if (!ok) fails++; };
const h = () => ({ "content-type": "application/json", ...(cookie ? { cookie } : {}) });

try {
  await sql`INSERT INTO sb.users (username, password_hash, role, status) VALUES (${USER}, ${hashPassword(PW)}, 'admin', 'approved')`;
  const li = await fetch(`${BASE}/api/login`, { method: "POST", headers: h(), body: JSON.stringify({ username: USER, password: PW }) });
  cookie = (li.headers.get("set-cookie") ?? "").split(";")[0];
  check("로그인", li.status === 200);
  check("화면 /wiki", (await fetch(`${BASE}/wiki`, { headers: h() })).status === 200);
  check("빈 질문 400", (await fetch(`${BASE}/api/wiki`, { method: "POST", headers: h(), body: JSON.stringify({ question: " " }) })).status === 400);
  check("로그인 없으면 401", (await fetch(`${BASE}/api/wiki`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "x" }) })).status === 401);

  const r = await fetch(`${BASE}/api/wiki`, { method: "POST", headers: h(), body: JSON.stringify({ question: "PM85 스캐너가 첫 바코드를 못 읽어요", history: [] }) });
  check("SSE 응답", r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/event-stream"));
  const text = await r.text();
  const events = text.split("\n\n").filter(Boolean).map((c) => JSON.parse(c.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
  const last = events.at(-1);
  console.log("     이벤트:", events.map((e) => e.type).join(", "), "|", (last?.message ?? "").slice(0, 120));
  check("끝 이벤트(done 또는 error)", last?.type === "done" || last?.type === "error");
  const [log] = await sql`SELECT id, question, error, found FROM sb.qa_logs WHERE username = ${USER} ORDER BY id DESC LIMIT 1`;
  check("질문 기록", Boolean(log) && Number(log.id) === last?.qa_id, `qa ${log?.id} error=${(log?.error ?? "").slice(0, 60)}`);
  const fb = await fetch(`${BASE}/api/wiki/${log.id}/feedback`, { method: "POST", headers: h(), body: JSON.stringify({ rating: -1, comment: "테스트" }) });
  check("평가", fb.status === 200);
  const mine = await (await fetch(`${BASE}/api/wiki/logs?scope=mine`, { headers: h() })).json();
  const gaps = await (await fetch(`${BASE}/api/wiki/logs?scope=gaps`, { headers: h() })).json();
  check("내 질문 · 보강 거리", mine.items?.[0]?.id === Number(log.id) && gaps.items?.some((x: { id: number }) => x.id === Number(log.id)));
} finally {
  await sql`DELETE FROM sb.qa_logs WHERE username = ${USER}`;
  await sql`DELETE FROM sb.users WHERE username = ${USER}`;
  await sql.end();
}
console.log(fails ? `\n실패 ${fails}건` : "\n모두 통과");
process.exit(fails ? 1 : 0);
