/**
 * Claude 와 초안 고치기 — 담당자가 지시하면 Claude 가 이슈 원문과 지금 초안을 보고 고친 문서 전체를 돌려준다.
 * 저장하지 않는다: 화면이 수정안을 보여 주고, 담당자가 [적용]해야 편집 칸에 들어간다(그 뒤 저장 · 확정은 평소대로).
 */
import { z } from "zod";
import { MODEL, parseStructured } from "../claude";
import { issueUrlMaker } from "./client";
import { Naming } from "./events";
import { DISCLOSURES, issueText, sanitizeHtml, SYSTEM } from "./sb";
import { issueWithJournals } from "./store";

const EDIT_MODEL = process.env.SB_EDIT_MODEL || MODEL;

const SBEdit = z.object({
  title: z.string().describe("고친 제목. 지시가 없으면 지금 제목 그대로. 앞의 '[TR] ' 은 지시가 없으면 유지"),
  disclosure: z.enum(["internal", "public", "partner", "ascp"]).describe("공개 등급. 지시가 없으면 지금 등급 그대로"),
  disclosure_reason: z.string().describe("그 등급인 이유 한 문장"),
  applies_to: z.string().describe("'1) Applies to' 값. 지시가 없으면 그대로"),
  description_html: z.string().describe(
    "고친 '2) Description' 본문 전체 HTML — <p>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <tr>, <th>, <td>, <br>, <a href> 만. "
    + "지시와 관계없는 부분은 글자 하나 바꾸지 않는다"),
  changes: z.string().describe("무엇을 왜 바꿨는지 한국어 1~3문장. 바꾼 것이 없으면 '바꾼 것 없음'"),
  reply: z.string().describe("지시가 질문이면 그 답(한국어). 질문이 아니면 빈 문자열"),
});

const EDIT_RULES = `지금 하는 일: 이미 만든 SB 문서 초안을 담당자의 지시대로 고친다.

고치는 규칙:
- 위의 SB 문서 규칙을 그대로 지킨다(실명 · 직급 · 고객사 담당자 이름 금지, 추측 금지, Redmine 번호 · 링크 포함).
- 지시가 가리키는 부분만 고치고 나머지는 그대로 둔다. 문서 전체를 다시 쓰라는 지시일 때만 전체를 고친다.
- 이슈 원문에 근거가 없는 원인 · 수치 · 버전 · 절차를 새로 넣지 않는다. 지시가 그런 내용을 요구하면 넣지 말고 changes 에 그 이유를 적는다.
- 지시가 질문(예: "이 등급이 맞아?")이면 reply 에 답하고, 고칠 필요가 없으면 문서는 그대로 돌려준다.
- 공개 등급을 바꾸라는 지시가 없으면 등급은 그대로 둔다. 바꿀 때는 보수적으로(확신이 없으면 internal).`;

export type AssistTurn = { instruction: string; changes: string };
export type AssistForm = { title: string; disclosure: string; applies_to: string; description_html: string };

export async function assistEdit(opts: { issueId: number; form: AssistForm; instruction: string; history: AssistTurn[] }) {
  const issue = await issueWithJournals(opts.issueId);
  if (!issue) return { ok: false as const, error: "이슈를 찾을 수 없습니다." };
  const source = issueText(issue, await Naming.load(), await issueUrlMaker());
  const f = opts.form;
  const history = opts.history.slice(-6)
    .map((h, i) => `${i + 1}. 지시: ${h.instruction}\n   결과: ${h.changes}`).join("\n");

  const prompt = [
    "[Redmine 이슈 원문]", source, "",
    "[현재 초안] — 담당자가 화면에서 고치던 내용(저장 전일 수 있다)",
    `제목: ${f.title}`,
    `공개 등급: ${f.disclosure} (${DISCLOSURES[f.disclosure] ?? ""})`,
    `Applies to: ${f.applies_to}`,
    "Description(HTML):", f.description_html || "(비어 있음)", "",
    ...(history ? ["[이번 대화에서 앞서 한 지시]", history, ""] : []),
    "[이번 지시]", opts.instruction,
  ].join("\n");

  const res = await parseStructured({
    system: `${SYSTEM}\n\n${EDIT_RULES}`,
    prompt,
    schema: SBEdit,
    operation: "SB 문서 수정",
    maxTokens: 16000,
    model: EDIT_MODEL,
  });
  if (!res.ok) return { ok: false as const, error: res.error };
  const d = res.data;
  return {
    ok: true as const,
    proposal: {
      title: d.title.trim() || f.title,
      disclosure: d.disclosure in DISCLOSURES ? d.disclosure : f.disclosure,
      applies_to: d.applies_to.trim(),
      description_html: sanitizeHtml(d.description_html),
    },
    disclosure_reason: d.disclosure_reason,
    changes: d.changes.trim(),
    reply: d.reply.trim(),
    model: res.model,
  };
}
