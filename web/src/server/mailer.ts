/**
 * 앱이 보내는 모든 메일의 발송구(nodemailer · SMTP STARTTLS 587).
 *
 * **로그인 계정과 보이는 발신자를 나눈다.**
 *  · 로그인(SMTP AUTH)  : 공용 계정 하나 — TW_MAIL_ACCOUNT. 지정이 없으면 보내는 계정(user_id) 본인.
 *  · 보이는 발신자(From): 시스템 주소 하나(TW_MAIL_FROM). 사람 주소는 From 에 넣지 않는다
 *    (앱이 보낸 메일을 그 사람이 직접 쓴 것으로 읽어 혼선이 컸다 — 2026-08-25 사용자 지적).
 *  · 답장(Reply-To)     : 시스템 관리자(TW_MAIL_REPLY_TO 가 있으면 그것).
 *  · 반송(Return-Path)  : 로그인 계정. 시스템 주소에 사서함이 없어도 배달 실패 통지가 사라지지 않는다.
 *  · 항상 참조(Cc)      : TW_MAIL_ALWAYS_CC(보낸 사람 · 받는 사람이면 넣지 않는다).
 * 사내 메일 서버가 From 을 검사하지 않아 가능한 구성이다(실측 2026-08-25).
 * 시스템 주소는 회사 도메인 안이어야 한다 — 다른 도메인은 DMARC 정렬에 걸린다.
 *
 * TW_MAIL_FROM 을 두지 않으면 보내는 계정 명의로 나가고, 그 사람 이름 서명이 붙는다.
 * 이 앱이 보내는 메일은 모두 시스템 안내다(SB 검토 요청 · 회원가입 · 계정 알림).
 */
import nodemailer from "nodemailer";
import { decryptSecret } from "./crypto";
import { sql } from "./db";
import * as shadow from "./shadow";
import { listStaff } from "./staff";

type SendIdentity = { email: string; password: string; host: string; port: number };

const env = (k: string) => (process.env[k] || "").trim();

/** POP 서버 이름에서 SMTP 호스트를 정한다. USER_SMTP_HOST 가 있으면 그것. */
export function smtpHostFor(popServer: string): string {
  const override = env("USER_SMTP_HOST");
  if (override) return override;
  const p = (popServer || "").trim();
  const pl = p.toLowerCase();
  if (pl.includes("office365") || pl.includes("outlook")) return "smtp.office365.com";
  for (const pre of ["pop3.", "pop.", "imap."]) if (pl.startsWith(pre)) return "smtp." + p.slice(pre.length);
  // 그 외(자체 메일서버 등): POP 과 같은 호스트를 SMTP 로 쓴다(mail.pointmobile.com 겸용).
  return p || "smtp.office365.com";
}

export const smtpPort = () => Number.parseInt(env("USER_SMTP_PORT") || "587", 10) || 587;

/** 사용자의 메일 자격증명 → SMTP 발송 신원. 미등록 · 복호화 실패면 null. */
async function getSendIdentity(userId: number): Promise<SendIdentity | null> {
  const [c] = await sql<{ email_address: string; encrypted_password: string; pop_server: string }[]>`
    SELECT email_address, encrypted_password, pop_server FROM sb.mail_credentials WHERE user_id = ${userId}`;
  if (!c || !c.email_address || !c.encrypted_password) return null;
  let pw = "";
  try {
    pw = decryptSecret(c.encrypted_password);
  } catch {
    return null;
  }
  if (!pw) return null;
  return { email: c.email_address.trim(), password: pw, host: smtpHostFor(c.pop_server), port: smtpPort() };
}

/** 시스템 명의 발신 설정 — [보이는 주소, 표시 이름, 답장 받을 주소]. */
export function systemFrom(): [string, string, string] {
  return [env("TW_MAIL_FROM"), env("TW_MAIL_FROM_NAME") || "Solution Buffer", env("TW_MAIL_REPLY_TO")];
}

/** 앱이 보내는 모든 메일에 참조로 넣을 주소(TW_MAIL_ALWAYS_CC, 쉼표 구분). */
export function alwaysCc(): string[] {
  const out: string[] = [];
  for (const part of (process.env.TW_MAIL_ALWAYS_CC || "").replace(/;/g, ",").split(",")) {
    const a = part.trim();
    if (a && a.includes("@") && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out;
}

/** TW_MAIL_ACCOUNT(계정 이름 또는 메일 주소) → 계정 id. */
async function relayUserId(): Promise<number | null> {
  const key = env("TW_MAIL_ACCOUNT");
  if (!key) return null;
  const [a] = await sql<{ user_id: number }[]>`SELECT user_id FROM sb.mail_credentials WHERE email_address = ${key} LIMIT 1`;
  if (a) return a.user_id;
  const [b] = await sql<{ id: number }[]>`SELECT id FROM sb.users WHERE username = ${key} LIMIT 1`;
  return b?.id ?? null;
}

/** 모든 메일이 실제로 로그인할 계정. TW_MAIL_ACCOUNT 가 없으면 보내는 사람 본인. */
async function relayIdentity(fallbackUserId: number | null): Promise<SendIdentity | null> {
  if (!env("TW_MAIL_ACCOUNT")) return fallbackUserId ? getSendIdentity(fallbackUserId) : null;
  const uid = await relayUserId();
  return uid ? getSendIdentity(uid) : null;
}

/** 로그인 아이디 → 메일 주소. 아이디가 주소면 그것, 아니면 명부에서 앞자리가 같은 주소. 없으면 ''. */
async function emailFromUsername(username: string): Promise<string> {
  const name = (username || "").trim();
  if (!name) return "";
  if (name.includes("@")) return name;
  const low = name.toLowerCase();
  for (const s of await listStaff()) {
    const addr = (s.email || "").trim();
    if (addr && addr.split("@", 1)[0].toLowerCase() === low) return addr;
  }
  return "";
}

/** 그 사람 명의로 보낼 때 쓸 [주소, 표시 이름, 서명]. */
export async function senderProfile(userId: number): Promise<[string, string, string]> {
  const [c] = await sql<{ email_address: string; signature_html: string }[]>`
    SELECT email_address, signature_html FROM sb.mail_credentials WHERE user_id = ${userId}`;
  const [u] = await sql<{ username: string }[]>`SELECT username FROM sb.users WHERE id = ${userId}`;
  let addr = (c?.email_address || "").trim();
  const sig = (c?.signature_html || "").trim();
  const uname = u?.username ?? "";
  addr = addr || (await emailFromUsername(uname));
  const name = (await displayNameFor(addr)) || uname;
  return [addr, name, sig || (addr ? await nameSignature(addr) : "")];
}

/** 사용자의 메일 주소 — 등록한 발송 계정 → 가입 때 받은 주소 → 아이디 순. 없으면 ''. */
export async function userEmail(userId: number): Promise<string> {
  const [c] = await sql<{ email_address: string }[]>`SELECT email_address FROM sb.mail_credentials WHERE user_id = ${userId}`;
  if (c?.email_address) return c.email_address.trim();
  const [u] = await sql<{ username: string; email: string }[]>`SELECT username, email FROM sb.users WHERE id = ${userId}`;
  if (u && (u.email || "").trim()) return u.email.trim();
  return emailFromUsername(u?.username ?? "");
}

/** 해당 역할 승인 계정들의 메일 주소(중복은 한 번만). */
async function roleEmails(roles: string[], excludeUsername = ""): Promise<string[]> {
  const rows = await sql<{ id: number; username: string }[]>`
    SELECT id, username FROM sb.users
    WHERE role = ANY(${roles}) AND status = 'approved' AND username <> ${excludeUsername}
    ORDER BY id`;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const addr = (await userEmail(r.id)) || (await emailFromUsername(r.username));
    if (addr && !seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase());
      out.push(addr);
    }
  }
  return out;
}

/** 시스템 안내 메일을 어느 계정 앞으로 돌릴지. 공용 발송 계정 → 자격증명 있는 관리자. 없으면 null. */
export async function systemSenderUserId(): Promise<number | null> {
  const relay = await relayUserId();
  if (relay) return relay;
  const [r] = await sql<{ id: number }[]>`
    SELECT u.id FROM sb.users u JOIN sb.mail_credentials m ON m.user_id = u.id
    WHERE m.encrypted_password <> ''
    ORDER BY (u.role <> 'admin'), u.id LIMIT 1`;
  return r?.id ?? null;
}

/** 시스템 관리자(role=admin) 이메일 목록. */
export function adminEmails(): Promise<string[]> {
  return roleEmails(["admin"]);
}

/** 시스템 관리자 이메일 — 여럿이 함께 쓰는 공용 'admin' 계정은 뺀다(사용자 확정 2026-08-19). */
export function systemAdminEmails(): Promise<string[]> {
  return roleEmails(["admin"], "admin");
}

/** 안내 메일에 싣는 서비스 주소. 배포처가 바뀌면 TW_APP_URL 로 덮는다. */
export function appUrl(): string {
  return (process.env.TW_APP_URL || "http://localhost:3070").replace(/\/+$/, "");
}

// 사내 메일의 본문 서식 — Outlook 회신 메일의 <style> 블록(맑은 고딕 10pt, 사용자 확정 2026-08-19).
const MAIL_CSS = [
  "p.MsoNormal, li.MsoNormal, div.MsoNormal",
  "   {margin:0cm; text-align:justify; text-justify:inter-ideograph;",
  "    text-autospace:none; word-break:break-hangul;",
  '    font-size:10.0pt; font-family:"맑은 고딕";}',
  "body, div.WordSection1, table, td, p, li, span",
  '   {font-size:10.0pt; font-family:"맑은 고딕";}',
  "a:link, span.MsoHyperlink",
  "   {color:#467886; text-decoration:underline;}",
].join("\n");

const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 평문 → <p class=MsoNormal> 줄들. 빈 줄은 Outlook 처럼 &nbsp; 한 줄. 앞 공백은 살린다. */
function textToHtml(text: string): string {
  return (text || "").split("\n").map((line) => {
    const s = line.trimEnd();
    if (!s.trim()) return "<p class=MsoNormal><o:p>&nbsp;</o:p></p>";
    const lead = s.length - s.trimStart().length;
    return "<p class=MsoNormal>" + "&nbsp;".repeat(lead) + esc(s.trim()) + "</p>";
  }).join("\n");
}

/** 평문 본문 + (서명) → 사내 서식의 HTML 메일 한 통. */
export function buildHtmlMail(body: string, signature = ""): string {
  const parts = [textToHtml(body)];
  if (signature.trim()) parts.push("<p class=MsoNormal><o:p>&nbsp;</o:p></p>", signature.includes("<") ? signature : textToHtml(signature));
  return '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style><!--\n'
    + MAIL_CSS + "\n--></style></head><body lang=KO><div class=WordSection1>\n" + parts.join("\n") + "\n</div></body></html>";
}

/** HTML 조각 → 평문(평문판에도 서명이 남게). */
export function htmlToText(doc: string): string {
  let s = (doc || "").replace(/<(br|\/p|\/div|\/tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/ /g, " ");
  return s.split(/\r?\n/).map((x) => x.trimEnd()).join("\n").trim();
}

/** 보내는 사람 표시 이름. 명부에 있으면 그 이름, 없으면 주소에서 만든다(damon.park@… → Damon Park). */
export async function displayNameFor(email: string): Promise<string> {
  const addr = (email || "").trim();
  if (!addr) return "";
  try {
    const [r] = await sql<{ name: string }[]>`SELECT name FROM sb.staff WHERE email ILIKE ${addr} LIMIT 1`;
    if (r && (r.name || "").trim()) return r.name.trim();
  } catch {
    // 명부가 없어도 서명은 나가야 한다
  }
  const local = addr.split("@", 1)[0];
  return local.replace(/_/g, ".").split(".").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** 서명 — 이름 한 줄만 남색 굵은 글자로(사용자 확정 2026-08-19). */
export async function nameSignature(email: string): Promise<string> {
  const name = await displayNameFor(email);
  return name ? `<p class=MsoNormal><b><span style='color:#376092'>${name}</span></b></p>` : "";
}

/** SMTP 로그인까지만 해 본다(메일은 보내지 않는다). */
export async function verifySmtp(host: string, port: number, user: string, pass: string): Promise<void> {
  const t = nodemailer.createTransport({
    host, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 20_000,
  });
  try {
    await t.verify();
  } finally {
    t.close();
  }
}

/**
 * 시스템 안내 메일 발송. [성공, 오류사유]. 검증 모드면 기록만 하고 [true, ""].
 * html: 다 만든 HTML 본문(mailHtml.ts 의 기능별 양식). 주면 그대로 싣고 개인 서명은 붙이지 않는다 — 평문(body)은 함께 실린다.
 */
export async function sendAsUser(userId: number, to: string | string[], subject: string, body: string,
  opts: { html?: string } = {}): Promise<[boolean, string]> {
  if (await shadow.blocked("mail", "send", { user_id: userId, to, subject, body, html: opts.html ? "(HTML 양식)" : "" })) return [true, ""];
  const ident = await relayIdentity(userId);
  if (!ident) return [false, "발송 계정 미등록 — [계정 관리]에서 본인 이메일 자격증명을 등록하세요."];
  const tos = (Array.isArray(to) ? to : [to]).map((t) => (t || "").trim()).filter(Boolean);
  if (!tos.length) return [false, "수신 주소가 비어 있습니다."];

  const [sysFrom, sysName, sysReply] = systemFrom();
  let showFrom: string, showName: string, signature: string, replyTo: string;
  if (sysFrom) {
    showFrom = sysFrom; showName = sysName; signature = "";
    // 시스템 주소에 사서함이 없을 수 있어 답장은 시스템 관리자가 받는다.
    replyTo = sysReply || (await systemAdminEmails())[0] || ident.email;
  } else {
    const [pfAddr, pfName, sig] = await senderProfile(userId);
    showFrom = pfAddr || ident.email; showName = pfName; signature = opts.html ? "" : sig; replyTo = "";
  }

  const seen = new Set([...tos.map((t) => t.toLowerCase()), showFrom.toLowerCase()]);
  const cc = alwaysCc().filter((a) => !seen.has(a.toLowerCase()));
  const plain = signature ? body.trimEnd() + "\n\n" + htmlToText(signature) : body;
  const domain = showFrom.split("@")[1] || "localhost";

  const t = nodemailer.createTransport({
    host: ident.host, port: ident.port, secure: ident.port === 465, requireTLS: ident.port !== 465,
    auth: { user: ident.email, pass: ident.password },
    connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 30_000,
  });
  try {
    await t.sendMail({
      from: showName ? { name: showName, address: showFrom } : showFrom,
      to: tos,
      cc: cc.length ? cc : undefined,
      replyTo: replyTo || undefined,
      subject,
      text: plain,
      html: opts.html || buildHtmlMail(body, signature),
      // 봉투 발신자(Return-Path)는 실제 계정 — From 만 시스템 주소로 바꾼다.
      envelope: { from: ident.email, to: [...tos, ...cc] },
      messageId: `<${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
      date: new Date(),
      // 앱이 보낸 메일 표식 — 같은 사서함을 읽는 tw-next 의 수신 필터가 이걸 보고 신규 요청에서 뺀다.
      headers: { "X-TW-Automation": "1" },
    });
    return [true, ""];
  } catch (e) {
    return [false, `SMTP 발송 실패: ${e instanceof Error ? e.message : String(e)}`];
  } finally {
    t.close();
  }
}
