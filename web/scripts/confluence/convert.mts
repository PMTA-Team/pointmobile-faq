/**
 * Confluence 저장 형식(XHTML + ac:/ri: 매크로) → 깨끗한 HTML · 평문 · 메타데이터.
 *
 * 이미지 · 문서 링크는 이관 때 새 id 가 정해지므로 자리표시를 남긴다:
 *   {{att:<pageId>|<filename>}}  → /api/kb/files/<kb_attachments.id>
 *   {{page:<spaceKey>|<title>}} · {{pageid:<contentId>}}  → /faq/<kb_articles.id>
 * import-confluence.mts 가 자리표시를 바꿔 넣는다.
 */
import * as cheerio from "cheerio";
import sanitizeHtml from "sanitize-html";
import { htmlToText, products } from "../../src/server/kb/text.ts";

export { htmlToText, products };

export const CONFLUENCE_BASE = "http://post.solution-pointmobile.co.kr:8040";

/** 목록 · 탐색용 매크로 — 다른 페이지를 끌어와 보여 주기만 하므로 문서 내용이 아니다. */
const NAV_MACROS = new Set(["contentbylabel", "children", "ui-children", "toc", "create-from-template", "content-report-table",
  "detailssummary", "recently-updated", "pagetree", "pagetreesearch", "livesearch", "creationdate", "blog-posts", "page-index",
  "listlabels", "popular-labels", "related-labels", "navmap", "attachments", "space-attachments"]);
const CALLOUT = new Set(["info", "note", "tip", "warning", "panel", "ui-text-box", "divbox"]);
const UNWRAP = new Set(["column", "section", "excerpt", "div", "span", "center", "align", "layout"]);

export type Converted = {
  html: string;
  text: string;
  author: string;          // details 매크로의 Author 칸
  navOnly: boolean;        // 목록 매크로만 있고 내용이 없는 페이지(분류용)
  unknownMacros: string[];
  props: { summary?: string; appliesTo?: string; partner?: string };   // details 표의 Summary · Model/Applies to · Partner
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function convert(storage: string, pageId: number, spaceKey: string): Converted {
  const $ = cheerio.load(`<cf-root>${storage}</cf-root>`, { xml: { xmlMode: true, decodeEntities: false } });
  let author = "";
  let hadNav = false;
  const props: { summary?: string; appliesTo?: string; partner?: string } = {};
  const unknown = new Set<string>();

  const param = (m: cheerio.Cheerio<any>, name: string) =>
    m.children("ac\\:parameter").filter((_, e) => $(e).attr("ac:name") === name).first();
  const paramText = (m: cheerio.Cheerio<any>, name: string) => param(m, name).text().trim();
  const richBody = (m: cheerio.Cheerio<any>) => m.children("ac\\:rich-text-body").first().html() ?? "";

  // 첨부를 가리키는 ri:attachment → 자리표시. 다른 페이지의 첨부면 그 페이지 제목으로 찾는다.
  const attRef = (el: cheerio.Cheerio<any>) => {
    const fn = el.attr("ri:filename") ?? "";
    const page = el.children("ri\\:page").first();
    return page.length ? `{{attp:${page.attr("ri:space-key") ?? spaceKey}|${page.attr("ri:content-title") ?? ""}|${fn}}}`
                       : `{{att:${pageId}|${fn}}}`;
  };
  const pageRef = (el: cheerio.Cheerio<any>) =>
    `{{page:${el.attr("ri:space-key") ?? spaceKey}|${el.attr("ri:content-title") ?? ""}}}`;

  // 1) 매크로 — 안쪽부터(문서 순서의 거꾸로) 바꿔야 겹친 매크로가 바르게 풀린다.
  const macros = $("ac\\:structured-macro, ac\\:macro").toArray().reverse();
  for (const node of macros) {
    const m = $(node);
    const name = (m.attr("ac:name") ?? "").toLowerCase();
    const body = richBody(m);
    let out = "";
    if (name === "details") {
      // 맨 위 속성 표(Author · creation date · JIRA Ticket Link · Summary · Partner · Model · Applies to · Description).
      // 작성자 · 작성일은 메타데이터로만 쓰고, 나머지 칸은 본문 맨 위 정보 표로 살린다 — 예전 SB 양식은 본문 전체가 이 표 안에 있다.
      const t = cheerio.load(body, { xml: { xmlMode: true, decodeEntities: false } });
      const rows: string[] = [];
      t("tr").each((_, tr) => {
        const th = t(tr).children("th").first();
        const td = t(tr).children("td").first();
        const k = th.text().trim();
        const kl = k.toLowerCase();
        if (!th.length || !td.length) { rows.push(`<tr>${t(tr).html() ?? ""}</tr>`); return; }
        if (kl === "author" || kl === "작성자") { author = td.text().trim(); return; }
        if (kl === "creation date" || kl === "작성일") return;
        td.find("p").filter((_, p) => /아래 툴을 이용해 JIRA Ticket/.test(t(p).text())).remove();
        const v = td.html() ?? "";
        const plain = td.text().trim();
        if (kl === "summary" && plain) props.summary = plain;
        if ((kl === "model" || kl === "applies to") && plain) props.appliesTo ||= plain;
        if (kl === "partner" && plain) props.partner = plain;
        if (plain || /<img|ac:image|jira/.test(v)) rows.push(`<tr><th>${esc(k)}</th><td>${v}</td></tr>`);
      });
      out = rows.length ? `<table class="props"><tbody>${rows.join("")}</tbody></table>` : "";
    } else if (NAV_MACROS.has(name)) {
      hadNav = true;
    } else if (CALLOUT.has(name)) {
      const type = name === "ui-text-box" ? (paramText(m, "type") || "info") : name === "divbox" || name === "panel" ? "note" : name;
      const title = paramText(m, "title");
      out = `<div class="callout callout-${esc(type)}">${title ? `<p class="callout-title">${esc(title)}</p>` : ""}${body}</div>`;
    } else if (name === "ui-steps") {
      out = `<ol class="steps">${body}</ol>`;
    } else if (name === "ui-step") {
      out = `<li>${body}</li>`;
    } else if (name === "ui-expand" || name === "expand") {
      out = `<details><summary>${esc(paramText(m, "title") || "더 보기")}</summary>${body}</details>`;
    } else if (name === "ui-tabs") {
      out = `<div class="tabs">${body}</div>`;
    } else if (name === "ui-tab") {
      out = `<section class="tab"><h4>${esc(paramText(m, "title"))}</h4>${body}</section>`;
    } else if (name === "code" || name === "noformat") {
      const lang = paramText(m, "language");
      const title = paramText(m, "title");
      const code = m.children("ac\\:plain-text-body").first().text();
      out = `${title ? `<p class="code-title">${esc(title)}</p>` : ""}<pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(code)}</code></pre>`;
    } else if (name === "jira") {
      const key = paramText(m, "key");
      out = key ? `<span class="jira">JIRA ${esc(key)}</span>` : "";
    } else if (name === "ui-button") {
      const url = paramText(m, "url");
      const title = paramText(m, "title") || url;
      out = url ? `<a href="${esc(url)}">${esc(title)}</a>` : esc(title);
    } else if (name === "view-file" || name === "multimedia") {
      const att = param(m, "name").children("ri\\:attachment").first();
      if (att.length) out = `<a class="file" href="${attRef(att)}">${esc(att.attr("ri:filename") ?? "")}</a>`;
    } else if (name === "excerpt-include" || name === "include") {
      const page = param(m, "").find("ri\\:page").first();
      if (page.length) out = `<p class="include">→ <a href="${pageRef(page)}">${esc(page.attr("ri:content-title") ?? "")}</a></p>`;
    } else if (UNWRAP.has(name)) {
      out = body;
    } else {
      unknown.add(name);
      out = body;
    }
    m.replaceWith(out);
  }

  // 2) 이미지 · 링크 · 할 일 · 레이아웃
  $("ac\\:image").each((_, e) => {
    const im = $(e);
    const att = im.children("ri\\:attachment").first();
    const url = im.children("ri\\:url").first();
    const src = att.length ? attRef(att) : url.attr("ri:value") ?? "";
    const w = im.attr("ac:width");
    im.replaceWith(src ? `<img src="${esc(src)}" alt=""${w ? ` width="${esc(w)}"` : ""} loading="lazy">` : "");
  });
  $("ac\\:link").each((_, e) => {
    const l = $(e);
    const label = l.children("ac\\:plain-text-link-body").text() || l.children("ac\\:link-body").html() || "";
    const page = l.children("ri\\:page").first();
    const att = l.children("ri\\:attachment").first();
    const url = l.children("ri\\:url").first();
    let href = "";
    let text = label;
    if (page.length) { href = pageRef(page); text ||= esc(page.attr("ri:content-title") ?? ""); }
    else if (att.length) { href = attRef(att); text ||= esc(att.attr("ri:filename") ?? ""); }
    else if (url.length) { href = url.attr("ri:value") ?? ""; text ||= esc(href); }
    l.replaceWith(href ? `<a href="${esc(href)}">${text}</a>` : text);
  });
  $("ac\\:task").each((_, e) => {
    const t = $(e);
    const done = t.children("ac\\:task-status").text().trim() === "complete";
    t.replaceWith(`<li>${done ? "☑" : "☐"} ${t.children("ac\\:task-body").html() ?? ""}</li>`);
  });
  $("ac\\:task-list").each((_, e) => { $(e).replaceWith(`<ul class="tasks">${$(e).html() ?? ""}</ul>`); });
  $("ac\\:layout, ac\\:layout-section, ac\\:layout-cell").each((_, e) => { $(e).replaceWith(`<div>${$(e).html() ?? ""}</div>`); });
  $("ac\\:placeholder, ac\\:emoticon, ac\\:inline-comment-marker").each((_, e) => {
    const t = $(e);
    t.replaceWith(t.is("ac\\:inline-comment-marker") ? (t.html() ?? "") : "");
  });
  $("time").each((_, e) => { $(e).replaceWith(esc($(e).attr("datetime") ?? $(e).text())); });

  // 3) Confluence 절대 주소 → 자리표시(이관된 문서면 FAQ 안으로)
  $("a[href]").each((_, e) => {
    const a = $(e);
    const href = a.attr("href") ?? "";
    const m1 = href.match(/\/display\/([^/?#]+)\/([^?#]+)/);
    const m2 = href.match(/viewpage\.action\?pageId=(\d+)/);
    if (m2) a.attr("href", `{{pageid:${m2[1]}}}`);
    else if (m1) a.attr("href", `{{page:${decodeURIComponent(m1[1])}|${decodeURIComponent(m1[2].replace(/\+/g, " "))}}}`);
  });

  let html = $("cf-root").html() ?? "";
  html = sanitizeHtml(html, {
    allowedTags: ["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "del",
      "code", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "img", "div", "span", "details",
      "summary", "section", "hr", "sup", "sub"],
    allowedAttributes: {
      a: ["href", "class"], img: ["src", "alt", "width", "loading"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
      table: ["class"],
      div: ["class"], p: ["class"], ol: ["class"], ul: ["class"], section: ["class"], span: ["class"], code: ["class"],
    },
    allowedClasses: {
      table: ["props"],
      div: ["callout", "callout-info", "callout-note", "callout-tip", "callout-warning", "callout-success", "callout-error", "tabs"],
      p: ["callout-title", "code-title", "include"], ol: ["steps"], ul: ["tasks"], section: ["tab"], span: ["jira"],
      a: ["file"], code: [/^language-/],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    // 자리표시({{…}})는 스킴 검사에 걸리지 않게 그대로 둔다.
    allowProtocolRelative: false,
    transformTags: { b: "strong", i: "em" },
    // 글자도 이미지도 없는 껍데기 span · div 는 버린다(빈 문단 p 는 아래에서 줄인다).
    exclusiveFilter: (f) => (f.tag === "span" || f.tag === "div") && !f.text.trim() && !(f.mediaChildren?.length),
  });
  // 빈 안내 상자(목록 매크로만 담고 있던 'RELATED ARTICLES' 등) · 빈 문단 정리
  html = html.replace(/<div class="callout[^"]*">(\s|<p class="callout-title">[^<]*<\/p>|<p>\s*(&nbsp;)?\s*<\/p>|<br \/>)*<\/div>/g, "")
             .replace(/(<p>\s*(&nbsp;|<br \/>)?\s*<\/p>\s*){2,}/g, "<p></p>")
             .trim();

  const text = htmlToText(html);
  const navOnly = hadNav && text.replace(/\s+/g, "").length < 60;
  return { html, text, author, navOnly, unknownMacros: [...unknown], props };
}

/** 적용 모델 줄 — SB: '1) Applies to : …', KB · TR: 'APPLIES TO' 제목 다음 줄. */
export function appliesTo(text: string): string {
  const m = text.match(/applies\s*to\s*[:：]?\s*\|?\s*([^\n]*)\n?([^\n]*)/i);
  if (!m) return "";
  let v = (m[1] || "").replace(/^[\s:：|]+/, "").trim();
  if (!v || /^description/i.test(v)) v = (m[2] || "").trim();
  if (/^\d\)\s*description/i.test(v)) return "";
  return v.slice(0, 300);
}

/** Redmine 이슈 번호 — 링크 · 'Issue #12345' · '#12345'(5자리). */
export function redmineIds(html: string, text: string): number[] {
  const out = new Set<number>();
  for (const m of html.matchAll(/issue\.pointmobile\.co\.kr\/issues\/(\d+)/g)) out.add(Number(m[1]));
  for (const m of text.matchAll(/(?:issue|이슈|redmine)\s*#?\s*(\d{4,6})\b/gi)) out.add(Number(m[1]));
  for (const m of text.matchAll(/(?:^|[\s(\[,])#\s?(\d{4,6})\b/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

export function disclosureOf(labels: string[]): string {
  if (labels.includes("confidential")) return "internal";
  if (labels.includes("ascp")) return "ascp";
  if (labels.includes("partner")) return "partner";
  return "public";
}

export function kindOf(spaceKey: string, labels: string[]): string {
  if (spaceKey === "SB") return "resolution";
  if (spaceKey === "TRguide" || labels.includes("kb-troubleshooting-article") || labels.includes("troubleshooting")) return "troubleshooting";
  if (labels.includes("kb-how-to-article")) return "how_to";
  return "guide";
}
