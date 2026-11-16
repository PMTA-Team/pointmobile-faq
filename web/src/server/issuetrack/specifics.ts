/**
 * 원문 대조 — 원문(메일 · 이슈)에 있는 '따라 하는 데 꼭 필요한 것'(히든 메뉴 진입, 다이얼 코드, 메뉴 경로, 명령,
 * 인텐트 · 패키지 이름, 버전)을 규칙으로 뽑고, 초안에 빠진 것을 찾는다. Claude 는 부르지 않는다.
 * 초안을 만든 직후 빠진 것이 있으면 한 번 더 고쳐 쓰게 하고(sb.ts), 검토 화면에도 보여 준다.
 */

export type Specific = { kind: string; text: string };

const PATTERNS: [string, RegExp][] = [
  ["다이얼 코드", /\*#\*#\d{2,}#\*#\*|\*#[0-9*#]{2,}#|##\d{3,}#/g],
  // 히든 메뉴 진입 — '…를 N번 누르/터치/탭' 이 들어간 문장
  ["히든 메뉴 진입", /[^\n.。]{0,60}(\d{1,2}\s?(번|회)|\b\d{1,2}\s?times)\s?(연속\s?)?(터치|탭|누르|클릭|tap|press|click)[^\n.。]{0,40}/gi],
  ["히든 · 개발자 메뉴", /hidden ?menu|히든 ?메뉴|engineer(?:ing)? ?mode|엔지니어 ?모드|factory ?mode|개발자 ?옵션|developer options|service ?mode/gi],
  ["명령", /\badb (?:shell |install |logcat|reboot|push |pull |sideload|devices)[^\n]{0,70}|\b(?:am (?:start|broadcast)|pm (?:grant|disable|enable|uninstall)|settings put|setprop|getprop|dumpsys)\b[^\n]{0,70}/gi],
  ["메뉴 경로", /(?:Settings|설정|EmKit|EmSettings|ScanSettings?|Scan2Stage|Scan2Set|PMDM|OEMConfig)\s*(?:>|→|->|›)\s*[^\n>→›]{1,40}(?:\s*(?:>|→|->|›)\s*[^\n>→›]{1,40})*/g],
  ["인텐트 · 패키지", /\b(?:com\.pointmobile\.[\w.]+|device\.sdk\.[\w.]+|android\.intent\.[\w.]+|[a-z]{2,}\.[a-z]{2,}\.[\w]+\.(?:ACTION|EXTRA)_[A-Z_]+|(?:ACTION|EXTRA)_[A-Z][A-Z_]{3,})\b/g],
  ["버전", /\b\d{2,3}\.\d{2}\s?(?:[A-Z]\d{1,2})\b|\b[A-Z]{2,4}\d{0,2}[A-Z]?\d{2}\.\d{2}\s?B\d{1,2}\b/g],
];

const norm = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
  .replace(/[→›]|->/g, ">").replace(/\s+/g, " ").trim();

/** 원문에서 뽑는다(같은 것은 한 번). */
export function specificsOf(source: string): Specific[] {
  const out: Specific[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of PATTERNS) {
    for (const m of source.match(re) ?? []) {
      const text = m.replace(/\s+/g, " ").trim().replace(/[,;:]+$/, "");
      const key = norm(text);
      if (text.length < 3 || seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, text: text.slice(0, 160) });
    }
  }
  return out;
}

/** 초안에 없는 것. 앞부분(경로는 마지막 두 단계, 그 밖은 앞 24자)이 초안에 들어 있으면 남은 것으로 본다. */
export function missingIn(draftHtml: string, items: Specific[]): Specific[] {
  const d = norm(draftHtml);
  return items.filter((it) => {
    const t = norm(it.text);
    if (it.kind === "메뉴 경로") {
      const steps = t.split(">").map((s) => s.trim()).filter(Boolean);
      return !steps.slice(-2).every((s) => d.includes(s.slice(0, 20)));
    }
    if (it.kind === "히든 메뉴 진입") {
      const n = /(\d{1,2})\s?(번|회|times)/i.exec(t)?.[1];
      return !(n && new RegExp(`${n}\\s?(번|회|times)`, "i").test(d));
    }
    if (it.kind === "히든 · 개발자 메뉴") return !d.includes(t);
    return !d.includes(t.slice(0, 24));
  });
}
