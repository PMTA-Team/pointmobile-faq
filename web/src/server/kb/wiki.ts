/**
 * LLM Wiki — Claude 에이전트가 FAQ(sb.kb_articles)를 도구로 찾아 읽고, 출처를 단 해결 가이드를 준다.
 *
 * - 도구: search_faq(검색) · get_faq(문서 전체). FAQ 화면과 같은 검색 함수(search.ts)를 쓴다.
 * - 도구 결과는 search_result 블록으로 넘긴다 → Claude 가 답의 문장마다 출처(문서 · 인용한 글)를 단다.
 * - 한 질문에 도구는 최대 MAX_ROUNDS 번. 질문 · 답 · 인용 · 검색 내역은 sb.qa_logs 에 남긴다(못 찾은 질문 = 새 문서 거리).
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { sql } from "../db";
import { recordUsage } from "../usage";
import { getArticle, KINDS, searchArticles } from "./search";

// LLM Wiki 는 Haiku — 빠르고 싸다(질문마다 검색 · 읽기를 여러 번 한다). SB 초안 모델(SB_MODEL)과 따로 정한다.
const MODEL = process.env.WIKI_MODEL || "claude-haiku-5-5";
// 서버 측 대체 모델(fallbacks)은 Haiku 에는 없다 — 목록으로 주면 400, "default" 는 효과가 없다. 다른 모델일 때만 켠다.
const USE_FALLBACK = !/haiku/i.test(MODEL);
const EFFORT = (process.env.WIKI_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";
const MAX_ROUNDS = 6;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const SYSTEM = `당신은 Point Mobile 기술지원팀의 지식 도우미입니다. 팀이 처리한 이슈의 기록과 How-to · Troubleshooting 문서를 모은 사내 FAQ 를 찾아, 질문에 대한 해결 가이드를 줍니다.

일하는 방법:
- 답하기 전에 반드시 search_faq 로 FAQ 를 찾고, 쓸 만한 문서는 get_faq 로 전문을 읽으세요. 기억이나 일반 지식으로 답을 지어내지 마세요.
- FAQ 문서는 한국어와 영어가 섞여 있습니다. 한 번에 못 찾으면 표현을 바꿔 다시 찾으세요 — 영어로 옮겨서(예: 스캐너 → scanner, 초기화 → factory reset), 모델 코드로(PM85, PM451), 증상 · 기능 이름으로.
- 질문에 모델이 있으면 그 모델에 맞는 문서를 먼저 쓰고, 다른 모델 문서를 쓸 때는 그렇다고 밝히세요.

답하는 방법:
- 질문한 언어로 답하세요(기본은 한국어). 첫 줄에 결론을 한두 문장으로 쓰세요.
- 그다음 필요한 만큼: 확인할 것(환경 · 원인 후보) → 해결 단계(번호 목록) → 참고할 문서.
- 모든 사실과 단계는 FAQ 문서에 근거해야 하고, 근거 문서를 인용하세요. 문서에 없는 버전 · 수치 · 설정값을 만들지 마세요.
- FAQ 에 맞는 내용이 없으면 "FAQ 에서 해당 내용을 찾지 못했습니다"라고 분명히 말하고, 가장 가까운 문서와 Redmine 에 이슈로 남길 것을 권하세요.
- 공개 등급이 internal 인 문서에서 가져온 내용은 '내부 자료 — 고객에게 그대로 전달하지 말 것'이라고 표시하세요.
- 짧고 실무적으로 쓰세요. 장황한 서론이나 같은 말 반복은 빼세요.`;

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_faq",
    eager_input_streaming: true,
    description: "사내 FAQ(처리한 이슈의 해결 기록 · How-to · Troubleshooting 문서)를 검색한다. 결과는 관련도순 문서 목록(제목 · 종류 · 적용 모델 · 발췌). "
      + "검색어는 공백으로 나눈 단어가 모두 들어간 문서를 찾고, 없으면 일부 단어만 맞는 문서를 준다. '#33526' 처럼 Redmine 이슈 번호로도 찾는다.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 — 증상 · 기능 · 모델 코드 · 오류 문구. 한국어 · 영어 모두 가능" },
        product: { type: "string", description: "모델 코드로 거르기(예: PM85). 모를 때는 비운다" },
        kind: { type: "string", enum: ["resolution", "troubleshooting", "how_to", "guide"], description: "문서 종류로 거르기" },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "몇 건(기본 6)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_faq",
    eager_input_streaming: true,
    description: "FAQ 문서 하나의 전문을 읽는다(search_faq 결과의 id). 해결 단계 · 원인을 답에 쓰기 전에 읽는다.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "문서 id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
const SearchIn = z.object({
  query: z.string().min(1).max(300),
  product: z.string().max(20).optional(),
  kind: z.enum(["resolution", "troubleshooting", "how_to", "guide"]).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
const GetIn = z.object({ id: z.number().int().positive() });

const source = (id: number) => `/faq/${id}`;
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

/** 긴 본문을 인용 단위(문단 묶음 ≈ 1,200자)로 나눈다 — Claude 는 블록 단위로 인용한다. */
function chunks(text: string, max = 1200, total = 14000): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.slice(0, total).split(/\n{2,}/)) {
    if (cur && cur.length + para.length > max) { out.push(cur.trim()); cur = ""; }
    cur += para + "\n\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : ["(본문 없음)"];
}

export type WikiEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "done"; qa_id: number; blocks: AnswerBlock[]; sources: WikiSource[]; found: boolean }
  | { type: "error"; message: string; qa_id?: number };
export type AnswerBlock = { text: string; cites: number[] };          // cites = sources 의 번호(1부터)
export type WikiSource = { n: number; id: number; title: string; disclosure: string; quotes: string[] };

type Search = { tool: string; input: unknown; ids: number[] };

async function runTool(name: string, input: unknown, searches: Search[], seen: Map<number, { title: string; disclosure: string }>):
  Promise<Anthropic.Beta.BetaToolResultBlockParam["content"]> {
  if (name === "search_faq") {
    const p = SearchIn.safeParse(input);
    if (!p.success) throw new Error("검색 입력이 올바르지 않습니다");
    const r = await searchArticles({ q: p.data.query, product: p.data.product, kind: p.data.kind, limit: p.data.limit ?? 6 });
    searches.push({ tool: name, input: p.data, ids: r.items.map((h) => h.id) });
    if (!r.items.length) return [{ type: "text", text: `"${p.data.query}" 로 찾은 문서가 없습니다. 다른 표현(영어 · 모델 코드 · 기능 이름)으로 다시 찾아보세요.` }];
    const head: Anthropic.Beta.BetaTextBlockParam = {
      type: "text",
      text: `${r.total}건 중 상위 ${r.items.length}건${r.loose ? " (모든 단어가 든 문서가 없어 일부 단어만 맞는 결과)" : ""}. 답에 쓰려면 get_faq 로 전문을 읽으세요.`,
    };
    return [head, ...r.items.map((h): Anthropic.Beta.BetaSearchResultBlockParam => {
      seen.set(h.id, { title: h.title, disclosure: h.disclosure });
      const meta = `id ${h.id} · ${KINDS[h.kind] ?? h.kind} · 공개 등급 ${h.disclosure}${h.applies_to ? ` · Applies to: ${h.applies_to}` : ""}`
        + `${h.products.length ? ` · 모델 ${h.products.join(", ")}` : ""}${h.redmine_issue_ids.length ? ` · Redmine #${h.redmine_issue_ids.join(", #")}` : ""}`
        + ` · 수정 ${h.updated_at.slice(0, 10)}`;
      return {
        type: "search_result", source: source(h.id), title: h.title, citations: { enabled: true },
        content: [{ type: "text", text: meta }, { type: "text", text: strip(h.snippets.join(" … ")) || "(발췌 없음)" }],
      };
    })];
  }
  if (name === "get_faq") {
    const p = GetIn.safeParse(input);
    if (!p.success) throw new Error("문서 id 가 올바르지 않습니다");
    const a = await getArticle(p.data.id);
    searches.push({ tool: name, input: p.data, ids: a ? [a.id] : [] });
    if (!a) return [{ type: "text", text: `id ${p.data.id} 문서가 없거나 내려진 문서입니다.` }];
    seen.set(a.id, { title: a.title, disclosure: a.disclosure });
    const meta = `id ${a.id} · ${KINDS[a.kind] ?? a.kind} · 공개 등급 ${a.disclosure} · 분류 ${a.category || "-"}`
      + `${a.applies_to ? ` · Applies to: ${a.applies_to}` : ""}${a.redmine_issue_ids.length ? ` · Redmine #${a.redmine_issue_ids.join(", #")}` : ""}`
      + ` · 작성 ${a.author || "-"} · 수정 ${a.updated_at.slice(0, 10)}`;
    return [{
      type: "search_result", source: source(a.id), title: a.title, citations: { enabled: true },
      content: [{ type: "text", text: meta }, ...chunks(a.body_text).map((t): Anthropic.Beta.BetaTextBlockParam => ({ type: "text", text: t }))],
    }];
  }
  throw new Error(`모르는 도구: ${name}`);
}

/** 질문 하나에 답한다. 진행 · 글자 · 끝을 emit 으로 흘려보낸다. */
export async function answer(opts: {
  question: string; history: { q: string; a: string }[]; user: { id: number; username: string };
  emit: (e: WikiEvent) => void; signal?: AbortSignal;
}): Promise<void> {
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const searches: Search[] = [];
  const seen = new Map<number, { title: string; disclosure: string }>();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const h of opts.history.slice(-4)) {
    messages.push({ role: "user", content: h.q }, { role: "assistant", content: h.a || "(답 없음)" });
  }
  messages.push({ role: "user", content: opts.question });
  let inTok = 0, outTok = 0;
  let final: Anthropic.Beta.BetaMessage | null = null;
  let error = "";

  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const lastRound = round === MAX_ROUNDS;
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        // 마지막 바퀴에는 도구를 주지 않는다 — 지금까지 읽은 것으로 답하게.
        ...(lastRound ? {} : { tools }),
        messages,
        output_config: { effort: EFFORT },
        ...(USE_FALLBACK ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      }, { signal: opts.signal });
      stream.on("text", (delta) => opts.emit({ type: "text", delta }));
      const msg = await stream.finalMessage();
      inTok += msg.usage.input_tokens ?? 0;
      outTok += msg.usage.output_tokens ?? 0;
      await recordUsage(msg.model || MODEL, msg.usage, "LLM Wiki");
      final = msg;
      if (msg.stop_reason === "refusal") { error = "Claude 가 이 질문에 답하지 않았습니다(정책 거절)"; break; }
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || !uses.length) break;
      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const inp = u.input as { query?: string; id?: number };
        opts.emit({ type: "status", text: u.name === "search_faq" ? `FAQ 검색: ${inp.query ?? ""}` : `문서 읽는 중: #${inp.id ?? ""}` });
        try {
          results.push({ type: "tool_result", tool_use_id: u.id, content: await runTool(u.name, u.input, searches, seen) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: (e as Error).message });
        }
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e instanceof Anthropic.APIError && /credit balance/i.test(e.message)) {
      error = "Anthropic API 크레딧이 부족해 답할 수 없습니다 — 관리자에게 알려 주세요(Plans & Billing 에서 충전)";
    } else if (e instanceof Anthropic.AuthenticationError) {
      error = "Anthropic API 키가 맞지 않습니다 — 관리자에게 알려 주세요";
    } else {
      error = e instanceof Anthropic.APIError ? `Claude API 오류(${e.status ?? "?"}): ${e.message}` : (e as Error).message;
    }
  }

  // 답 · 인용 정리 — 인용한 문서에 1부터 번호를 매긴다.
  const sources: WikiSource[] = [];
  const nOf = new Map<number, number>();
  const blocks: AnswerBlock[] = [];
  for (const b of final?.content ?? []) {
    if (b.type !== "text") continue;
    const cites: number[] = [];
    for (const c of b.citations ?? []) {
      if (c.type !== "search_result_location") continue;
      const id = Number(String(c.source).replace("/faq/", ""));
      if (!Number.isFinite(id)) continue;
      if (!nOf.has(id)) {
        const s = seen.get(id);
        nOf.set(id, sources.length + 1);
        sources.push({ n: sources.length + 1, id, title: s?.title ?? c.title ?? `#${id}`, disclosure: s?.disclosure ?? "", quotes: [] });
      }
      const src = sources[nOf.get(id)! - 1];
      if (c.cited_text && src.quotes.length < 3) src.quotes.push(c.cited_text.slice(0, 300));
      if (!cites.includes(nOf.get(id)!)) cites.push(nOf.get(id)!);
    }
    blocks.push({ text: b.text, cites });
  }
  const answerText = blocks.map((b) => b.text).join("");
  const found = sources.length > 0;

  const [row] = await sql<{ id: number }[]>`
    INSERT INTO sb.qa_logs (user_id, username, question, answer, cited_ids, searches, found, model, input_tokens, output_tokens, error)
    VALUES (${opts.user.id}, ${opts.user.username}, ${opts.question}, ${answerText}, ${sources.map((s) => s.id)},
            ${sql.json(searches as never)}, ${error ? null : found}, ${final?.model ?? MODEL}, ${inTok}, ${outTok}, ${error || null})
    RETURNING id`;
  if (error) opts.emit({ type: "error", message: error, qa_id: row.id });
  else opts.emit({ type: "done", qa_id: row.id, blocks, sources, found });
}
