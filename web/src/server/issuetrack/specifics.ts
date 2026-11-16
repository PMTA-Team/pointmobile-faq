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

/** 띄어쓰기 · 따옴표 · 문장부호를 지운 비교용 문자열. */
const squash = (s: string) => norm(s).replace(/[\s"'“”‘’`.,;:()[\]{}!?~·…-]+/g, "");

/** 낱말(2글자 이상, 조사 붙은 꼬리는 뗀다) — 경로 단계 · 문장에서 핵심 낱말만 본다. */
const words = (s: string) =>
  norm(s).split(/[\s"'“”‘’`.,;:()[\]{}!?>/]+/)
    .map((w) => w.replace(/(에서|으로|에는|이고|하고|라는|이라는|를|을|이|가|은|는|에|로|의|와|과)$/, ""))
    .filter((w) => w.length >= 2 && !/^(설정|settings|활성화|비활성화|있습니다|합니다|부탁|드립니다|확인|해야|하실|수|있고|있으며)$/.test(w));

/**
 * 초안에 없는 것. 띄어쓰기 · 문장부호 · 태그 차이는 무시한다.
 *   · 경로: 마지막 두 단계의 핵심 낱말(단계마다 앞 두 낱말)이 초안에 있으면 남은 것으로 본다.
 *   · 히든 메뉴 진입: 횟수(N번)가 초안에 있으면.  · 그 밖: 앞 20자(공백 제거)가 있으면.
 */
export function missingIn(draftHtml: string, items: Specific[]): Specific[] {
  const d = squash(draftHtml);
  return items.filter((it) => {
    if (it.kind === "메뉴 경로") {
      const steps = norm(it.text).split(">").map((s) => s.trim()).filter(Boolean).slice(-2);
      return !steps.every((s) => words(s).slice(0, 2).every((w) => d.includes(squash(w))));
    }
    if (it.kind === "히든 메뉴 진입") {
      const n = /(\d{1,2})\s?(번|회|times)/i.exec(it.text)?.[1];
      return !(n && new RegExp(`${n}(번|회|times)`, "i").test(d));
    }
    if (it.kind === "명령") {
      // 명령이 든 문장은 명령 부분(adb … / am … 의 앞 세 낱말)만 본다
      const cmd = /(adb|am|pm|settings|setprop|getprop|dumpsys)\s+\S+(\s+\S+)?/i.exec(it.text)?.[0] ?? it.text;
      return !d.includes(squash(cmd).slice(0, 20));
    }
    return !d.includes(squash(it.text).slice(0, 20));
  });
}
