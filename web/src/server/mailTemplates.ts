/**
 * 앱이 보내는 메일의 **문구 모음**. 고치려면 이 파일을 고친다.
 *
 * 예전 화면에서 고쳐 sb.mail_templates 에 남은 문구가 있으면 그것이 우선한다(지우면 기본 문구로 돌아간다).
 *
 * 문구 안의 {{이름}} 은 보낼 때 실제 값으로 바뀐다. {{앱주소}}·{{문의주소}}·{{오늘}} 은 어느 문구에서나
 * 쓸 수 있다(AUTO). 아는 이름이 아닌 {{...}} 는 손대지 않고 그대로 둔다(오타 때문에 발송이 실패하지 않게).
 * 서명은 본문에 넣지 않는다 — 보낼 때 mailer 가 붙인다.
 */
import { sql } from "./db";
import { appUrl, systemAdminEmails } from "./mailer";
import { kstDay } from "./time";

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

// ── 만들기 ──────────────────────────────────────────────────────────────────

/** {{이름}} 을 값으로 바꾼다. 모르는 이름은 그대로 둔다. */
function fill(text: string, values: Record<string, string | number>): string {
  return (text || "").replace(VAR, (all, name: string) => (name in values ? String(values[name]) : all));
}

/** [제목, 본문]. 고친 문구가 남아 있으면 그것으로 만든다. 부르는 쪽 값이 AUTO 보다 우선. */
export async function render(key: string, values: Record<string, string | number>): Promise<[string, string]> {
  const t = TEMPLATES[key];
  if (!t) return ["", ""];
  const [row] = await sql<{ subject: string; body: string }[]>`
    SELECT subject, body FROM sb.mail_templates WHERE key = ${key}`;
  const vals = { ...(await autoValues()), ...values };
  return [fill(row?.subject ?? t.subject, vals), fill(row?.body ?? t.body, vals)];
}
