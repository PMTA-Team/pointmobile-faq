/**
 * 메일 규칙 — 잡음 거르기 · 본문 정리 · 스레드 묶는 제목 키. Claude 는 부르지 않는다.
 *
 * 규칙은 받은 메일함(2026-07~10, 대화 964개)을 직접 읽고 정했다. Redmine 알림 · 부재중 · 자동 메일 · 사내 공지 ·
 * OS 배포 공지 · 업체 알림을 거르면 사람이 주고받은 문의만 남는다.
 */

export type Noise = "" | "redmine" | "ooo" | "auto" | "release" | "internal" | "vendor";

export const NOISE_LABEL: Record<Exclude<Noise, "">, string> = {
  redmine: "Redmine 알림",
  ooo: "부재중 알림",
  auto: "자동 메일",
  release: "배포 공지",
  internal: "사내 공지 · 보고",
  vendor: "업체 · 계정 알림",
};

const RULES: [Exclude<Noise, "">, (m: { from: string; subject: string }) => boolean][] = [
  ["redmine", (m) => /^pmissue@/i.test(m.from) || /- Issue #\d+\]/.test(m.subject)],
  ["ooo", (m) => /부재\s?중|부재 알림|out of office|automatic reply|자동\s?회신|自动回复|지연출근|\[연차\]/i.test(m.subject)],
  ["auto", (m) =>
    /^(tw\.auto|noreply|no-reply|donotreply|mailer-daemon|postmaster)@/i.test(m.from) ||
    /\[TW Automation( Test)?\]|\[TW 테스트\]|\[GS Automation\]|\[AUTOMATION\]|\[PMDM License (승인|반려)\]|\[White ?List\]|\[검수 (요청|승인)\]|\[승인 요청\]|\[PM-FILE\]|Microsoft Outlook 테스트 메시지|\[Android Partners\]|Partner announcements from week|Service Announcement|\[FIH\]\[(Approval|Submission|GMS)\]|android-partner-security|\[3pl-oem\]|Android GMS Announcements|GMS (MR|IR) approval test|\bMR plan\b|Inquiry Submission Completed/i.test(m.subject)],
  ["release", (m) =>
    /@pointmobile\.com$/i.test(m.from) &&
    /\]\s*.*\s배포(\s|$|\[)|\bRC 배포\b|재배포|Official Image|Release notes|릴리즈|\bOS Update$|^Release\s/i.test(m.subject)],
  ["internal", (m) =>
    /주간\s?업무\s?보고|주간\s?보고|외근 보고|출장보고|일일 보고|\[(긴급|REMIND)?공지\]|\[(재)?안내\]|\[결재|\[참조자 등록\]|\[열람자 등록\]|\[커뮤니티|訃告|부고|급여명세서|신규\s?입사|퇴사 인사|장기 휴직|\[분실물\]|단체관람|결산 마감|여권 정보|자리이동|항공권|\[작업 공지|\[마케팅\]|\[업무 (시작 )?보고\]|^회수:|Project Schedule - 20\d\d|휴일 알림|\[연구소 공지|건강검진|OJT|기프티콘|아이스크림|근무시간/i.test(m.subject)],
  ["vendor", (m) =>
    /@([a-z0-9-]+\.)*(github\.com|vercel\.com|supabase\.com|atlassian\.com|openai\.com|anthropic\.com|claude\.com|accounts\.google\.com|teams\.mail\.microsoft|manageengine\.com|mailchimp\.com|teamviewer\.com|teamblind\.com|sfcustomeremail\.com|salesforce\.com|amazon\.com)$/i.test(m.from) ||
    /security alert|보안 경고|확인 코드|verification code|인증 코드|secure link|임시 인증|storage (is )?full|newsletter|webinar/i.test(m.subject)],
];

/** 규칙으로 거를 메일이면 그 이유, 사람이 볼 메일이면 ''. own 은 이 앱이 보낸 주소들(앱 알림 메일). */
export function noiseOf(m: { from: string; subject: string }, own: string[] = []): Noise {
  const from = (m.from || "").toLowerCase();
  if (own.some((a) => a && a.toLowerCase() === from) && /TA FAQ|SB 문서|검토 요청/.test(m.subject || "")) return "auto";
  for (const [k, f] of RULES) if (f({ from, subject: m.subject || "" })) return k;
  return "";
}

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|r|i|답장|전달|회신|回复|回覆|转发|轉寄)\s*(\[\d+\])?\s*[:：]\s*)+/i;

/** 답장 · 전달 제목인가(RE: · FW: · 回复: …). */
export function isReplySubject(subject: string): boolean {
  return REPLY_PREFIX.test(subject || "");
}

/** RE: · FW: · 回复: 등을 떼고 공백을 줄인 소문자 제목 — 참조 헤더가 없을 때 같은 스레드로 묶는 기준. */
export function subjectKey(subject: string): string {
  return (subject || "")
    .replace(REPLY_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// 인용이 시작되는 줄 — Outlook(한 · 영 · 중 · 독 · 일), Gmail, 구분선.
const QUOTE_START = new RegExp(
  [
    String.raw`^-{2,}\s*(original message|원본 메시지|forwarded message|전달된 메시지)`,
    String.raw`^_{10,}\s*$`,
    String.raw`^(from|보낸 사람|보낸사람|发件人|寄件者|von|差出人)\s*[:：]`,
    String.raw`^on .{5,120}wrote:\s*$`,
    String.raw`^20\d\d[.\-/년]\s?\d{1,2}[.\-/월]\s?\d{1,2}.{0,60}(작성|wrote|写道)`,
    String.raw`^>`,
  ].join("|"),
  "im",
);

// 서명이 시작되는 줄 — 'Thanks and best regards.' 와 이름 · 직함 · 전화 줄.
const SIGN_START = /^\s*(thanks (and|&) (best )?regards|best regards|kind regards|regards,|감사합니다\.?\s*$|이상입니다\.?\s*$|mit freundlichen grüßen|freundliche grüße|よろしくお願いいたします)/im;

/** 인용문 · 서명 · 지나친 빈 줄을 걷어낸 본문(이 메일에서 새로 쓴 부분만). */
export function cleanBody(text: string): string {
  let s = (text || "").replace(/\r/g, "").replace(/ /g, " ");
  const q = QUOTE_START.exec(s);
  if (q) s = s.slice(0, q.index);
  const g = SIGN_START.exec(s);
  if (g && g.index > 40) s = s.slice(0, g.index);
  return s
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 메일 주소의 로컬파트가 사내 계정이면 그 이름(jayden.lee), 아니면 ''. */
export function staffName(addr: string): string {
  const m = /^([a-z0-9._-]+)@pointmobile\.com$/i.exec((addr || "").trim());
  return m && !/^pm[_.]|^(sales\d*|ts|support|info|tw\.auto|pmissue)$/i.test(m[1]) ? m[1].toLowerCase() : "";
}
