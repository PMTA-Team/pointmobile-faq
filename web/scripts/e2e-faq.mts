/** FAQ · 확정 → FAQ 흐름을 빌드한 앱에 대고 확인한다. 임시 계정 · 테스트 흔적은 끝에 되돌린다. */
import postgres from "postgres";
import { hashPassword } from "../src/server/crypto.ts";

const BASE = process.argv[2] || "http://127.0.0.1:3177";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const USER = `faq_e2e_${Date.now()}`;
const PW = `e2e-${Math.random().toString(36).slice(2)}A1`;
let cookie = "";
let fails = 0;
const check = (name: string, ok: boolean, info = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!ok) fails++; };
async function call(method: string, path: string, body?: unknown, useCookie = true) {
  const r = await fetch(BASE + path, {
    method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie && useCookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch { /* 바이너리 · HTML */ }
  return { status: r.status, json, type: r.headers.get("content-type") ?? "", size: buf.length };
}

let artId = 0, views = 0, sbDoc = 0;
try {
  await sql`INSERT INTO sb.users (username, password_hash, role, status) VALUES (${USER}, ${hashPassword(PW)}, 'admin', 'approved')`;
  check("로그인", (await call("POST", "/api/login", { username: USER, password: PW })).status === 200);
  for (const p of ["/faq", "/faq/1"]) check(`화면 ${p}`, (await call("GET", p)).status === 200);

  const s = await call("GET", "/api/faq?q=" + encodeURIComponent("factory reset FRP"));
  check("검색", s.status === 200 && s.json.total > 0 && s.json.items[0].snippets.length > 0,
        `${s.json?.total}건, 1위 "${s.json?.items?.[0]?.title}"`);
  const f = await call("GET", "/api/faq?kind=troubleshooting&space=TRguide&limit=1");
  check("걸러 보기", f.status === 200 && f.json.total === f.json.facets.space.TRguide, `TRguide troubleshooting ${f.json?.total}`);

  // 이미지가 있는 문서
  const [img] = await sql`SELECT a.article_id, a.id FROM sb.kb_attachments a JOIN sb.kb_files f ON f.attachment_id = a.id
                          JOIN sb.kb_articles k ON k.id = a.article_id WHERE k.state = 'published' LIMIT 1`;
  artId = img.article_id;
  [{ views }] = await sql`SELECT view_count AS views FROM sb.kb_articles WHERE id = ${artId}`;
  const d = await call("GET", `/api/faq/${artId}`);
  check("문서", d.status === 200 && d.json.article.body_html.includes(`/api/kb/files/`), `"${d.json?.article?.title}" 관련 ${d.json?.related?.length}건`);
  const file = await call("GET", `/api/kb/files/${img.id}`);
  check("이미지", file.status === 200 && file.type.startsWith("image/") && file.size > 100, `${file.type} ${file.size}B`);
  check("이미지 로그인 없으면 401", (await call("GET", `/api/kb/files/${img.id}`, undefined, false)).status === 401);
  check("평가", (await call("POST", `/api/faq/${artId}/vote`, { up: true })).status === 200);

  // 확정 → FAQ → 확정 취소
  const [doc] = await sql`SELECT d.id, d.issue_id FROM sb.rm_sb_docs d WHERE d.state = 'draft' AND d.superseded = false
                          AND NOT EXISTS (SELECT 1 FROM sb.kb_articles k WHERE k.sb_doc_id = d.id) ORDER BY d.id DESC LIMIT 1`;
  sbDoc = doc.id;
  const cur = (await call("GET", `/api/issues/sb/${doc.id}`)).json;
  const form = { title: cur.title, disclosure: cur.disclosure, applies_to: cur.applies_to, description_html: cur.description_html, partners: cur.partners };
  check("확정", (await call("POST", `/api/issues/sb/${doc.id}/approve`, form)).status === 200);
  const [k1] = await sql`SELECT id, state, kind, source FROM sb.kb_articles WHERE sb_doc_id = ${doc.id}`;
  check("확정 → FAQ 에 올라감", k1?.state === "published" && k1.kind === "resolution" && k1.source === "sb", JSON.stringify(k1));
  const byIssue = await call("GET", `/api/faq?q=%23${doc.issue_id}`);
  check("이슈 번호로 찾힘", byIssue.json?.items?.some((x: { id: number }) => x.id === k1?.id), `#${doc.issue_id}`);
  check("확정 취소", (await call("POST", `/api/issues/sb/${doc.id}/reopen`)).status === 200);
  const [k2] = await sql`SELECT state FROM sb.kb_articles WHERE sb_doc_id = ${doc.id}`;
  const [st] = await sql`SELECT state FROM sb.rm_sb_docs WHERE id = ${doc.id}`;
  check("확정 취소 → FAQ 에서 내려감", k2?.state === "archived" && st.state === "draft", `kb=${k2?.state} doc=${st.state}`);
} finally {
  if (sbDoc) await sql`DELETE FROM sb.kb_articles WHERE sb_doc_id = ${sbDoc}`;
  if (artId) await sql`UPDATE sb.kb_articles SET view_count = ${views}, helpful_up = GREATEST(helpful_up - 1, 0) WHERE id = ${artId}`;
  await sql`DELETE FROM sb.users WHERE username = ${USER}`;
  await sql.end();
}
console.log(fails ? `\n실패 ${fails}건` : "\n모두 통과");
process.exit(fails ? 1 : 0);
