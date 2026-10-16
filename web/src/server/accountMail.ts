/**
 * 계정 안내 메일 — 가입 요청 알림 · 가입 결과 · 비밀번호 초기화.
 * 모두 시스템 명의로 나간다(답장은 Reply-To 를 따라 시스템 관리자에게). 신청자에게는 가입 때 받은 이메일로 보낸다.
 */
import { INITIAL_PASSWORD, type SignupInfo } from "./accounts";
import { sql } from "./db";
import { appUrl, sendAsUser, systemAdminEmails, systemSenderUserId } from "./mailer";
import { accountResetHtml, signupApprovedHtml, signupRejectedHtml, signupRequestHtml } from "./mailHtml";
import { render } from "./mailTemplates";
import { kstMinute } from "./time";

const LINE = "─".repeat(46);

/** 고정폭 메일에서 차지하는 칸 수 — 한글 등 넓은 글자는 두 칸. */
function width(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x20000 && c <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

/** 줄맞춤한 정보 상자. 문구에서는 {{정보표}} 한 자리로 들어간다. */
function table(rows: [string, string][]): string {
  const pad = Math.max(0, ...rows.map(([k]) => width(k)));
  return [LINE, ...rows.map(([k, v]) => `  ${k}${" ".repeat(pad - width(k))}   ${v}`), LINE].join("\n");
}

async function emailOf(username: string): Promise<string> {
  const [u] = await sql<{ email: string }[]>`SELECT email FROM sb.users WHERE username = ${username}`;
  const addr = (u?.email || "").trim();
  return addr || (username.includes("@") ? username : "");
}

/** 가입 신청 — 시스템 관리자에게 승인을 요청한다. */
export async function sendSignupRequest(info: { company: string; email: string; username: string }): Promise<[boolean, string]> {
  const tos = await systemAdminEmails();
  const sender = await systemSenderUserId();
  if (!tos.length || sender == null) return [false, "관리자 주소나 발송 계정이 없어 알리지 못했습니다."];
  const at = kstMinute(new Date());
  const accountsUrl = `${appUrl()}/settings/accounts`;
  const [subject, body] = await render("signup_request", {
    회사: info.company, 아이디: info.username, 계정관리주소: accountsUrl,
    정보표: table([["회사", info.company], ["이메일", info.email], ["ID", info.username], ["신청 시각", at]]),
  });
  return sendAsUser(sender, tos, subject, body, { html: signupRequestHtml({ ...info, at, accountsUrl }) });
}

/** 가입 승인 · 반려 결과 — 신청자에게. */
export async function sendSignupResult(info: SignupInfo, approved: boolean): Promise<[boolean, string]> {
  const sender = await systemSenderUserId();
  if (sender == null || !info.email) return [false, "발송 계정이나 신청자 주소가 없어 알리지 못했습니다."];
  const [subject, body] = approved
    ? await render("signup_approved", { 정보표: table([["서비스 주소", appUrl()], ["회사", info.company], ["ID", info.username]]) })
    : await render("signup_rejected", { 사유: info.reason || "-", 정보표: table([["회사", info.company], ["ID", info.username]]) });
  const html = approved
    ? signupApprovedHtml({ company: info.company, username: info.username, appUrl: appUrl() })
    : signupRejectedHtml({ company: info.company, username: info.username, reason: info.reason || "", appUrl: appUrl() });
  return sendAsUser(sender, info.email, subject, body, { html });
}

/** 비밀번호 초기화 안내 — 관리자가 초기화한 직후, 그 계정의 이메일로. */
export async function sendReset(actorUserId: number, username: string): Promise<[boolean, string]> {
  const to = await emailOf(username);
  if (!to) return [false, "이 계정의 이메일이 없어 알리지 못했습니다."];
  const [subject, body] = await render("account_reset", {
    정보표: table([["서비스 주소", appUrl()], ["아이디", username], ["초기 비밀번호", INITIAL_PASSWORD]]),
  });
  return sendAsUser(actorUserId, to, subject, body, { html: accountResetHtml({ username, password: INITIAL_PASSWORD, appUrl: appUrl() }) });
}
