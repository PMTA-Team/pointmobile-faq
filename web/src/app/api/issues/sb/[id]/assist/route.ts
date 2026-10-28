import { bad, body, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { loadDocFor } from "@/server/issuetrack/api";
import { assistEdit, type AssistForm, type AssistTurn } from "@/server/issuetrack/assist";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Claude 와 초안 고치기 — { instruction, form: {title, disclosure, applies_to, description_html}, history: [{instruction, changes}] }
 * → { proposal, changes, reply, disclosure_reason }. 저장하지 않는다(화면에서 [적용]해야 편집 칸에 들어간다).
 * 본인 담당(관리자는 전체) · 초안 · 검토 요청 상태의 문서만.
 */
export const POST = route(async (req, ctx) => {
  const u = await requireUser();
  const id = await paramInt(ctx, "id");
  const doc = await loadDocFor(u, id);
  if (!["draft", "notified"].includes(String(doc.state))) bad("초안 · 검토 요청 상태의 문서만 고칠 수 있습니다", 409);
  const b = await body<{ instruction: string; form: AssistForm; history: AssistTurn[] }>(req);
  const instruction = String(b.instruction ?? "").trim().slice(0, 2000);
  if (!instruction) bad("무엇을 고칠지 적어 주세요");
  const f = b.form ?? ({} as AssistForm);
  const form: AssistForm = {
    title: String(f.title ?? doc.title ?? ""), disclosure: String(f.disclosure ?? doc.disclosure ?? "internal"),
    applies_to: String(f.applies_to ?? doc.applies_to ?? ""), description_html: String(f.description_html ?? doc.description_html ?? ""),
  };
  const history = Array.isArray(b.history)
    ? b.history.slice(-6).map((h) => ({ instruction: String(h.instruction ?? "").slice(0, 1000), changes: String(h.changes ?? "").slice(0, 1000) }))
    : [];
  const r = await assistEdit({ doc: { source: doc.source, issue_id: doc.issue_id, mail_thread_id: doc.mail_thread_id }, form, instruction, history });
  if (!r.ok) bad(`Claude 수정 실패: ${r.error}`, 502);
  return r;
});
