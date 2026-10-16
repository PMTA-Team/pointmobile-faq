/**
 * 메일의 HTML 판 — 기능마다 안내 메일 양식으로(tw-automation-v2 의 license/mail_html.py 와 같은 방식).
 *
 * 평문(mailTemplates — 관리자가 [메일 문구]에서 고치는 글)은 그대로 함께 실린다. HTML 을 못 그리는 메일 프로그램은 그것을 보인다.
 * 개인 서명은 붙이지 않는다 — 시스템이 알리는 메일이라서.
 *
 * 메일 프로그램은 CSS 를 제대로 그리지 않는 것이 많아 겉틀은 표로 짜고 칸마다 style 을 직접 적는다.
 * 아웃룩은 표 칸에 글꼴을 물려주지 않고 margin 도 무시한다 — 칸마다 글꼴, 간격은 빈 줄(gap)로.
 */

const BRAND = "#2f6bff";
const BRAND_DARK = "#1f4fd6";
const INK = "#14213d";
const INK2 = "#4a5873";
const INK3 = "#8592a8";
const LINE = "#e3e8f2";
const SOFT = "#f4f7fd";
const FAMILY = "font-family:'Malgun Gothic','Apple SD Gothic Neo','Segoe UI',Arial,sans-serif";
const FONT = `${FAMILY};font-size:13.5px;color:${INK}`;
const MONO = "font-family:Consolas,'Courier New',monospace";
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

export const e = (v: unknown) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const gap = (px: number) =>
  `<div style="line-height:${px}px;mso-line-height-rule:exactly;font-size:${px}px;height:${px}px">&nbsp;</div>`;

const p = (html: string, last = false) => `<p style="${FONT};margin:0${last ? "" : " 0 6px"}">${html}</p>`;

/** 눈에 먼저 걸려야 하는 값 한 줄(이슈 번호 · 등급 · 판 …). 값은 HTML(이미 이스케이프한 것). */
function strip(cells: [string, string][]): string {
  const td = cells.map(([k, v]) =>
    `<td valign="top" style="${FAMILY};padding:11px 12px;border:1px solid ${LINE};background:${SOFT}">`
    + `<div style="${FAMILY};color:${INK3};font-size:11px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:.06em;text-transform:uppercase">${e(k)}</div>`
    + `<div style="${FAMILY};color:${INK};font-size:17px;line-height:23px;mso-line-height-rule:exactly;font-weight:700">${v}</div></td>`).join("");
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%"><tr>${td}</tr></table>${gap(18)}`;
}

/** 상세 — 왼쪽 항목 · 오른쪽 값(HTML). 빈 값은 줄째 뺀다. */
function rows(items: [string, string][]): string {
  const tr = items.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td valign="top" width="130" style="${FAMILY};font-size:12.5px;color:${INK3};padding:9px 14px;border-bottom:1px solid ${LINE};white-space:nowrap">${e(k)}</td>`
    + `<td valign="top" style="${FAMILY};font-size:13.5px;color:${INK};padding:9px 14px;border-bottom:1px solid ${LINE}">${v}</td></tr>`).join("");
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%;border-top:1px solid ${LINE}">${tr}</table>${gap(18)}`;
}

type Tone = "ok" | "fail" | "info" | "warn";
const TONE: Record<Tone, [string, string, string]> = {
  ok: ["#13804b", "#e9f7ef", "&#10003;"],
  fail: ["#c62828", "#fdecec", "&#10005;"],
  info: [BRAND_DARK, "#eaf0ff", "&#9679;"],
  warn: ["#b45309", "#fff4e5", "!"],
};

/** 결과 · 요청 띠 — 승인 초록, 반려 빨강, 할 일(결정을 기다림) 파랑. */
function banner(tone: Tone, title: string, sub = ""): string {
  const [color, bg, mark] = TONE[tone];
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%"><tr>`
    + `<td style="${FAMILY};background:${bg};border-left:4px solid ${color};padding:14px 18px">`
    + `<div style="${FAMILY};color:${color};font-size:16px;line-height:22px;mso-line-height-rule:exactly;font-weight:700">${mark}&nbsp; ${e(title)}</div>`
    + (sub ? `<div style="${FAMILY};color:${INK2};font-size:12.5px;line-height:18px;mso-line-height-rule:exactly">${e(sub)}</div>` : "")
    + `</td></tr></table>${gap(18)}`;
}

/** 받는 사람이 꼭 읽어야 하는 글(사유 · 안내 · 미리보기). text 는 평문(줄바꿈 유지). */
function box(label: string, text: string, tone: Tone | "plain" = "plain"): string {
  const [color, bg] = tone === "plain" ? [BRAND_DARK, SOFT] : TONE[tone];
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%"><tr>`
    + `<td style="${FAMILY};background:${tone === "plain" ? bg : bg};border:1px solid ${LINE};padding:14px 16px">`
    + `<div style="${FAMILY};color:${color};font-size:12px;line-height:16px;mso-line-height-rule:exactly;font-weight:700">${e(label)}</div>${gap(6)}`
    + `<div style="${FAMILY};color:${INK};font-size:13.5px;line-height:21px;mso-line-height-rule:exactly">${e(text).replace(/\n/g, "<br>")}</div>`
    + `</td></tr></table>${gap(18)}`;
}

/** 해야 할 일 — 번호 붙은 단계. */
function steps(items: string[]): string {
  const tr = items.map((s, i) =>
    `<tr><td valign="top" width="28" style="${FAMILY};padding:4px 0">`
    + `<div style="${FAMILY};width:20px;height:20px;line-height:20px;border-radius:10px;background:${BRAND};color:#ffffff;font-size:11px;font-weight:700;text-align:center">${i + 1}</div></td>`
    + `<td valign="top" style="${FAMILY};font-size:13.5px;line-height:21px;color:${INK};padding:3px 0 6px">${s}</td></tr>`).join("");
  return `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%">${tr}</table>${gap(14)}`;
}

/** 눌러서 가는 버튼 — 아웃룩도 그리게 표 칸에 색을 칠한다. 아래에 주소를 글로도. */
function button(label: string, url: string): string {
  return `<table ${TABLE} style="border-collapse:collapse"><tr><td bgcolor="${BRAND}" style="${FAMILY};background:${BRAND};border-radius:8px">`
    + `<a href="${e(url)}" target="_blank" style="${FAMILY};display:inline-block;padding:12px 26px;color:#ffffff;font-size:14px;font-weight:700;line-height:18px;text-decoration:none">${e(label)} &rarr;</a>`
    + `</td></tr></table>`
    + `<div style="${FAMILY};color:${INK3};font-size:11.5px;line-height:17px;mso-line-height-rule:exactly;padding-top:6px;word-break:break-all">${e(url)}</div>${gap(20)}`;
}

const link = (url: string, text = url) => `<a href="${e(url)}" target="_blank" style="color:${BRAND};text-decoration:none">${e(text)}</a>`;
const mono = (s: string) => `<span style="${MONO};font-size:13px">${e(s)}</span>`;

/** 겉틀 — 파란 머리(로고) · 본문 · 꼬리. 640px 표. */
function shell(title: string, inner: string): string {
  const year = new Date().getFullYear();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0">
<div style="margin:0;padding:28px 12px;background:#eef2f9;${FONT}">
<table ${TABLE} align="center" width="640" style="width:100%;max-width:640px;margin:0 auto;border-collapse:collapse;background:#ffffff;border:1px solid ${LINE}">
  <tr>
    <td bgcolor="${BRAND}" style="${FAMILY};padding:18px 22px;background:${BRAND};border-bottom:3px solid ${BRAND_DARK}">
      <table ${TABLE} style="border-collapse:collapse"><tr>
        <td width="36" height="36" align="center" valign="middle" bgcolor="#ffffff" style="${FAMILY};width:36px;height:36px;background:#ffffff;border-radius:9px;color:${BRAND};font-size:14px;font-weight:800;line-height:36px">SB</td>
        <td style="${FAMILY};padding-left:12px">
          <div style="${FAMILY};color:#ffffff;font-size:16px;line-height:20px;mso-line-height-rule:exactly;font-weight:700">Solution Buffer</div>
          <div style="${FAMILY};color:#d6e2ff;font-size:12px;line-height:16px;mso-line-height-rule:exactly">${e(title)}</div>
        </td>
      </tr></table>
    </td>
  </tr>
  <tr><td style="padding:24px 22px 8px;${FONT};line-height:21px;mso-line-height-rule:exactly">${inner}</td></tr>
  <tr>
    <td style="${FAMILY};padding:14px 22px 22px;border-top:1px solid ${LINE};color:${INK3};font-size:11.5px;line-height:1.7">
      Solution Buffer(Point Mobile 기술지원)에서 자동으로 보낸 메일입니다. 문의는 이 메일에 회신해 주세요.<br>&copy; ${year} Point Mobile Co., Ltd.
    </td>
  </tr>
</table>
</div></body></html>`;
}

// ── 기능별 ─────────────────────────────────────────────────────────────────────

/** 회원가입 이메일 인증번호 — 번호를 크게. */
export function signupCodeHtml(o: { code: string; minutes: number; appUrl: string }): string {
  const codeBox = `<table ${TABLE} width="100%" style="border-collapse:collapse;width:100%"><tr>`
    + `<td align="center" style="${FAMILY};background:${SOFT};border:1px solid ${LINE};padding:20px 16px">`
    + `<div style="${FAMILY};color:${INK3};font-size:12px;line-height:16px">인증번호</div>${gap(6)}`
    + `<div style="${MONO};color:${INK};font-size:32px;line-height:38px;font-weight:700;letter-spacing:8px">${e(o.code)}</div>`
    + `</td></tr></table>${gap(18)}`;
  const inner = p("안녕하세요.") + p("Solution Buffer 회원가입을 위한 이메일 인증번호입니다.", true) + gap(18)
    + codeBox
    + box("안내", `회원가입 화면의 인증번호 칸에 입력하세요. ${o.minutes}분 안에 입력해야 합니다.\n본인이 요청하지 않았다면 이 메일을 무시하세요.`, "plain")
    + `<div style="${FAMILY};color:${INK3};font-size:12px">${link(o.appUrl)}</div>${gap(8)}`;
  return shell("이메일 인증번호", inner);
}

/** 가입 신청 — 시스템 관리자에게 승인 요청. */
export function signupRequestHtml(o: { company: string; email: string; username: string; at: string; accountsUrl: string }): string {
  const inner = p("안녕하세요.") + p(`${e(o.company)}의 ${e(o.username)} 님이 Solution Buffer 가입을 신청했습니다.`, true) + gap(18)
    + banner("info", "가입 승인 요청", `${o.company} · ${o.username}`)
    + rows([["회사", e(o.company)], ["이메일", link(`mailto:${o.email}`, o.email)], ["ID", mono(o.username)], ["신청 시각", e(o.at)]])
    + button("계정 관리에서 승인 · 반려하기", o.accountsUrl);
  return shell("가입 승인 요청", inner);
}

/** 가입 승인 — 신청자에게. */
export function signupApprovedHtml(o: { company: string; username: string; appUrl: string }): string {
  const inner = p("안녕하세요.") + p("신청하신 Solution Buffer 가입이 승인되었습니다. 이제 로그인할 수 있습니다.", true) + gap(18)
    + banner("ok", "가입 승인", `${o.company} · ${o.username}`)
    + rows([["서비스 주소", link(o.appUrl)], ["회사", e(o.company)], ["ID", mono(o.username)]])
    + button("로그인하기", `${o.appUrl}/login`);
  return shell("가입 결과", inner);
}

/** 가입 반려 — 신청자에게. */
export function signupRejectedHtml(o: { company: string; username: string; reason: string; appUrl: string }): string {
  const inner = p("안녕하세요.") + p("신청하신 Solution Buffer 가입이 반려되었습니다.", true) + gap(18)
    + banner("fail", "가입 반려", `${o.company} · ${o.username}`)
    + box("반려 사유", o.reason || "-", "fail")
    + rows([["회사", e(o.company)], ["ID", mono(o.username)]])
    + p("내용을 고쳐 회원가입에서 다시 신청할 수 있습니다.", true) + gap(14)
    + button("다시 신청하기", `${o.appUrl}/signup`);
  return shell("가입 결과", inner);
}

/** 비밀번호 초기화 — 그 계정의 이메일로. */
export function accountResetHtml(o: { username: string; password: string; appUrl: string }): string {
  const inner = p("안녕하세요.") + p("관리자가 Solution Buffer 계정의 비밀번호를 초기화했습니다.", true) + gap(18)
    + banner("warn", "비밀번호 초기화", o.username)
    + rows([["서비스 주소", link(o.appUrl)], ["아이디", mono(o.username)], ["초기 비밀번호", mono(o.password)]])
    + box("안내", "다음 로그인 때 비밀번호 변경 화면이 먼저 열립니다. 새 비밀번호로 바꿔 주세요.\n본인이 요청하지 않았다면 관리자에게 알려 주세요.", "plain")
    + button("로그인하기", `${o.appUrl}/login`);
  return shell("비밀번호 초기화", inner);
}

/** SB 문서 검토 요청 — 이슈가 Resolved 되어 초안을 만들었을 때, 담당자(없으면 관리자)에게. */
export function sbReviewHtml(o: {
  assignee: string; issueId: number; issueSubject: string; issueUrl: string; title: string;
  disclosure: string; disclosureKo: string; reason: string; appliesTo: string; revision: number;
  preview: string; fallback: boolean; docUrl: string;
}): string {
  const inner = p(`${e(o.assignee || "담당자")} 님,`)
    + p(`담당하신 Redmine 이슈 <b>#${o.issueId}</b> 가 Resolved 되어, Solution Buffer 문서 초안을 자동으로 작성했습니다.`, true) + gap(18)
    + banner("info", "SB 문서 검토 요청", o.title)
    + strip([["Redmine", `#${o.issueId}`], ["추천 공개 등급", `${e(o.disclosure)} <span style="font-size:12px;color:${INK3}">${e(o.disclosureKo)}</span>`],
             ["판", o.revision > 1 ? `${o.revision}판` : "새 문서"]])
    + (o.fallback ? box("관리자에게 대신 보냄", `담당자(${o.assignee || "-"})의 메일 주소를 찾지 못해 관리자에게 보냅니다. 담당자에게 전달해 주세요.`, "warn") : "")
    + rows([
      ["이슈", `${link(o.issueUrl, `#${o.issueId}`)} ${e(o.issueSubject)}`],
      ["문서 제목", `<b>${e(o.title)}</b>`],
      ["Applies to", e(o.appliesTo)],
      ["등급 판단", e(o.reason)],
      ["개정", o.revision > 1 ? `${o.revision}판 — 이슈가 다시 열렸다가 해결되어 새로 작성했습니다` : ""],
    ])
    + (o.preview ? box("초안 미리보기", o.preview, "plain") : "")
    + steps([
      "제목 · 공개 등급 · 본문을 확인하고 필요하면 고칩니다.",
      "내용이 맞으면 <b>[확정]</b> 을 누릅니다 — 확정한 문서는 FAQ 에 올라갑니다.",
      "문서로 남길 필요가 없는 내용이면 <b>[폐기]</b> 로 정리합니다.",
    ])
    + button("SB 문서 검토하기", o.docUrl)
    + box("꼭 확인해 주세요", "초안은 이슈 내용을 바탕으로 AI 가 만든 것이라 사실관계와 표현을 확인해야 합니다. 공개 등급에 따라 고객에게 공개되는 문서입니다.", "warn");
  return shell("SB 문서 검토 요청", inner);
}
