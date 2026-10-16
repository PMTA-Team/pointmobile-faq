/** FAQ 문서의 평문 · 모델 코드 — 앱(확정 → FAQ)과 이관 스크립트가 같이 쓴다. */
import * as cheerio from "cheerio";

/** 검색 · LLM 용 평문 — 블록마다 줄을 바꾸고 표는 칸을 ' | ' 로. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html || "");
  $("br").replaceWith("\n");
  $("td, th").each((_, e) => { $(e).append(" | "); });
  $("p, li, h1, h2, h3, h4, h5, h6, tr, pre, summary, div, section, blockquote").each((_, e) => { $(e).append("\n"); });
  $("img").remove();
  return $.root().text()
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 모델 코드 — PM451 · PM85 · PM3+ · RF850 · EF501 … 대문자로, 띄어쓰기 · 붙임표 없이. */
export function products(...src: string[]): string[] {
  const out = new Set<string>();
  for (const s of src) {
    for (const m of (s || "").matchAll(/\b(PM|RF|EF|BI|EM|PC)[\s-]?(\d{1,3}[A-Z]?\+?)/gi)) out.add((m[1] + m[2]).toUpperCase());
  }
  return [...out].sort();
}
