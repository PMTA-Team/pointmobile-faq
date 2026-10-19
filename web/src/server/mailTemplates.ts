/**
 * 앱이 보내는 메일의 **문구 모음**. 화면([설정] → 메일 문구)에서 고칠 수 있다.
 *
 * 여기 있는 것은 기본 문구다. 사람이 고치면 sb.mail_templates 에 그것만 저장되고, 고친 적이 없으면
 * 기본 문구가 그대로 쓰인다. '기본값으로 되돌리기'는 저장된 행을 지우는 일이다.
 *
 * 문구 안의 {{이름}} 은 보낼 때 실제 값으로 바뀐다. {{앱주소}}·{{문의주소}}·{{오늘}} 은 어느 문구에서나
 * 쓸 수 있다(AUTO). 아는 이름이 아닌 {{...}} 는 손대지 않고 그대로 둔다(오타 때문에 발송이 실패하지 않게).
 * 서명은 본문에 넣지 않는다 — 보낼 때 mailer 가 붙인다.
 */
import { sql } from "./db";
import { appUrl, systemAdminEmails } from "./mailer";
import { kstDay, kstMinute } from "./time";

const VAR = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/** 어느 문구에서나 쓸 수 있는 값. 보낼 때 자동으로 채워진다. */
export const AUTO: Record<string, string> = {
  앱주소: "TA FAQ 주소 — 'http://192.168.121.35:3070'",
  문의주소: "문의를 받을 시스템 관리자 메일 주소",
  오늘: "보내는 날짜 — '2026-08-25'",
};

export async function autoValues(): Promise<Record<string, string>> {
  const admins = await systemAdminEmails();
  return { 앱주소: appUrl(), 문의주소: admins[0] ?? "", 오늘: kstDay() };
}

export type Tpl = {
  key: string; title: string; group: string; when: string; to: string;
  subject: string; body: string; vars: Record<string, string>;
};

export const TEMPLATES: Record<string, Tpl> = {};
const add = (t: Tpl) => { TEMPLATES[t.key] = t; };

const AUTO_NOTE = "이 메일은 TA FAQ 가 자동 발송했습니다.";

// ── 계정 ─────────────────────────────────────────────────────────────────────
add({
  key: "signup_request", title: "회원가입 승인 요청", group: "계정",
  when: "누군가 회원가입을 신청했을 때", to: "시스템 관리자",
  subject: "[TA FAQ] 회원가입 승인 요청 — {{회사}} {{아이디}}",
  body:
    "TA FAQ 회원가입 신청이 들어왔습니다.\n" +
    "\n" +
    "{{정보표}}\n" +
    "▶ [설정 → 계정] 에서 승인하거나 반려해 주십시오.\n" +
    "  {{계정관리주소}}\n" +
    "\n" +
    "승인하면 신청자에게 로그인 안내 메일이, 반려하면 사유가 담긴 메일이 나갑니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: { 회사: "신청한 회사명", 아이디: "신청한 ID", 정보표: "회사 · 이메일 · ID · 신청 시각 상자", 계정관리주소: "앱의 [설정 → 계정] 주소" },
});

add({
  key: "signup_email_code", title: "회원가입 이메일 인증번호", group: "계정",
  when: "회원가입 화면에서 [인증번호 받기] 를 눌렀을 때", to: "가입하려는 이메일",
  subject: "[TA FAQ] 이메일 인증번호 {{인증번호}}",
  body:
    "안녕하십니까.\n" +
    "TA FAQ 회원가입 이메일 인증번호입니다.\n" +
    "\n" +
    "    인증번호: {{인증번호}}\n" +
    "\n" +
    "회원가입 화면에 {{유효시간}} 안에 입력해 주십시오.\n" +
    "직접 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: { 인증번호: "6자리 숫자", 유효시간: "인증번호를 쓸 수 있는 시간 — '10분'" },
});

add({
  key: "signup_approved", title: "회원가입 승인 안내", group: "계정",
  when: "관리자가 가입을 승인했을 때", to: "신청자",
  subject: "[TA FAQ] 회원가입이 승인되었습니다",
  body:
    "안녕하십니까.\n" +
    "신청하신 TA FAQ 회원가입이 승인되었습니다.\n" +
    "\n" +
    "{{정보표}}\n" +
    "위 주소에서 신청하신 ID 와 비밀번호로 로그인하실 수 있습니다.\n" +
    "\n" +
    "사용 중 문의는 이 메일에 회신해 주시기 바랍니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: { 정보표: "서비스 주소 · 회사 · ID 상자" },
});

add({
  key: "signup_rejected", title: "회원가입 반려 안내", group: "계정",
  when: "관리자가 가입을 반려했을 때", to: "신청자",
  subject: "[TA FAQ] 회원가입 신청 결과 안내",
  body:
    "안녕하십니까.\n" +
    "신청하신 TA FAQ 회원가입은 아래 사유로 승인되지 않았습니다.\n" +
    "\n" +
    "{{정보표}}\n" +
    "사유: {{사유}}\n" +
    "\n" +
    "내용을 고쳐 같은 ID 로 다시 신청하실 수 있습니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: { 정보표: "회사 · ID 상자", 사유: "관리자가 적은 반려 사유" },
});

add({
  key: "account_reset", title: "비밀번호 초기화 안내", group: "계정",
  when: "관리자가 비밀번호를 초기화한 직후", to: "그 계정의 주인",
  subject: "[TA FAQ] 비밀번호가 초기화되었습니다",
  body:
    "안녕하십니까.\n" +
    "요청하신 대로 TA FAQ 비밀번호를 초기화했습니다.\n" +
    "\n" +
    "{{정보표}}\n" +
    "다음 로그인 때 비밀번호 변경 화면이 먼저 열립니다.\n" +
    "위 초기 비밀번호는 임시 값이므로, 본인만 아는 비밀번호로 바꾸신 뒤\n" +
    "이용해 주시기 바랍니다.\n" +
    "\n" +
    "본인이 요청하지 않으셨다면 다른 사람이 초기화를 요청했을 수 있습니다.\n" +
    "이 메일에 회신해 바로 알려 주시기 바랍니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: { 정보표: "서비스 주소·아이디·초기 비밀번호를 줄맞춤한 상자" },
});

// ── 자동 알림 ────────────────────────────────────────────────────────────────
add({
  key: "sb_review", title: "SB 문서 검토 요청", group: "자동 알림",
  when: "Redmine 이슈가 Resolved 되어 초안을 만들었을 때", to: "이슈 담당자 (없으면 관리자)",
  subject: "[TA FAQ] SB 문서 검토 요청 — #{{이슈번호}} {{문서제목}}",
  body:
    "{{담당자}} 님,\n" +
    "\n" +
    "담당하신 Redmine 이슈 #{{이슈번호}} 가 Resolved 되어, SB\n" +
    "문서 초안을 자동으로 작성했습니다.\n" +
    "\n" +
    "{{정보표}}{{대신보냄}}\n" +
    "────────────────────────────────────────────────────────\n" +
    "아래 주소로 로그인하시면 [업로드]에 본인 담당 문서만 모여 있습니다.\n" +
    "  {{화면주소}}\n" +
    "\n" +
    "  1. 제목·공개 등급·본문을 확인하고 필요하면 고칩니다.\n" +
    "  2. 내용이 맞으면 [확정] 을 누릅니다.\n" +
    "\n" +
    "확정하지 않으면 초안으로만 남습니다.\n" +
    "문서로 남길 필요가 없는 내용이면 [폐기] 로 정리해 주세요.\n" +
    "────────────────────────────────────────────────────────\n" +
    "\n" +
    "초안은 이슈 내용을 바탕으로 만든 것이라 사실관계와 표현을 꼭 확인해\n" +
    "주셔야 합니다. 고객에게 공개되는 문서입니다.\n" +
    "\n" +
    AUTO_NOTE,
  vars: {
    담당자: "이슈 담당자 이름", 이슈번호: "Redmine 이슈 번호", 문서제목: "만든 문서 제목",
    정보표: "이슈·문서 제목·추천 등급·Applies to (개정판이면 개정 줄까지)",
    대신보냄: "담당자 주소를 못 찾아 관리자에게 보낼 때의 안내(아니면 비어 있음)",
    화면주소: "TA FAQ [업로드] 화면 주소",
  },
});

// ── 저장·읽기 ────────────────────────────────────────────────────────────────

export function groups(): string[] {
  const out: string[] = [];
  for (const t of Object.values(TEMPLATES)) if (!out.includes(t.group)) out.push(t.group);
  return out;
}

export type TplState = Omit<Tpl, never> & {
  auto: Record<string, string>; default_subject: string; default_body: string;
  edited: boolean; updated_by: string; updated_at: string;
};

/** 고친 것이 있으면 그것. updated_at 은 'YYYY-MM-DD HH:MM'(KST). 없는 문구면 null. */
export async function get(key: string): Promise<TplState | null> {
  const t = TEMPLATES[key];
  if (!t) return null;
  let subject = t.subject, body = t.body, edited = false, by = "", at: Date | null = null;
  const [row] = await sql<{ subject: string; body: string; updated_by: string; updated_at: Date }[]>`
    SELECT subject, body, updated_by, updated_at FROM sb.mail_templates WHERE key = ${key}`;
  if (row) {
    subject = row.subject; body = row.body; edited = true; by = row.updated_by; at = row.updated_at;
  }
  return {
    key, title: t.title, group: t.group, when: t.when, to: t.to, subject, body,
    vars: { ...t.vars }, auto: { ...AUTO }, default_subject: t.subject, default_body: t.body,
    edited, updated_by: by, updated_at: kstMinute(at),
  };
}

export async function save(key: string, subject: string, body: string, actor = ""): Promise<[boolean, string]> {
  if (!TEMPLATES[key]) return [false, "없는 문구입니다."];
  if (!(subject || "").trim()) return [false, "제목을 비워 둘 수 없습니다."];
  if (!(body || "").trim()) return [false, "본문을 비워 둘 수 없습니다."];
  await sql`
    INSERT INTO sb.mail_templates (key, subject, body, updated_by, updated_at) VALUES (${key}, ${subject}, ${body}, ${actor}, now())
    ON CONFLICT (key) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
      updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return [true, "저장했습니다."];
}

/** 고친 것을 지워 기본 문구로 되돌린다. */
export async function reset(key: string): Promise<[boolean, string]> {
  const r = await sql`DELETE FROM sb.mail_templates WHERE key = ${key} RETURNING id`;
  return r.length ? [true, "기본 문구로 되돌렸습니다."] : [true, "이미 기본 문구입니다."];
}

function used(subject: string, body: string): Set<string> {
  const s = new Set<string>();
  for (const m of (subject || "").matchAll(VAR)) s.add(m[1]);
  for (const m of (body || "").matchAll(VAR)) s.add(m[1]);
  return s;
}

/** 문구에 쓰였지만 값이 채워지지 않는 이름들. */
export function unknownVars(key: string, subject: string, body: string): string[] {
  const known = new Set([...Object.keys(TEMPLATES[key]?.vars ?? {}), ...Object.keys(AUTO)]);
  return [...used(subject, body)].filter((n) => !known.has(n)).sort();
}

/** 이 문구만의 값인데 문구에서 빠진 이름들(AUTO 는 세지 않는다). */
export function missingVars(key: string, subject: string, body: string): string[] {
  const u = used(subject, body);
  return Object.keys(TEMPLATES[key]?.vars ?? {}).filter((n) => !u.has(n)).sort();
}

/** {{이름}} 을 값으로 바꾼다. 모르는 이름은 그대로 둔다. */
export function fill(text: string, values: Record<string, string | number>): string {
  return (text || "").replace(VAR, (all, name: string) => (name in values ? String(values[name]) : all));
}

/** [제목, 본문]. 고친 문구가 있으면 그것으로 만든다. 부르는 쪽 값이 AUTO 보다 우선. */
export async function render(key: string, values: Record<string, string | number>): Promise<[string, string]> {
  const cur = await get(key);
  if (!cur) return ["", ""];
  const vals = { ...(await autoValues()), ...values };
  return [fill(cur.subject, vals), fill(cur.body, vals)];
}

/** 미리보기용 예시 값 — 설명에서 따옴표 안의 예시를 뽑고, 없으면 이름을 쓴다. */
export async function sample(key: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, desc] of [...Object.entries(TEMPLATES[key]?.vars ?? {}), ...Object.entries(AUTO)]) {
    const m = /'([^']*)'/.exec(desc || "");
    out[name] = m ? m[1] : `(${name})`;
  }
  return { ...out, ...(await autoValues()) };
}
