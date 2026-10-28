import { sql } from "@/server/db";
import { bad, body, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { loadDocFor } from "@/server/issuetrack/api";

export const dynamic = "force-dynamic";

/** 메일 문서의 첨부를 FAQ 에 함께 올릴지 정한다 — { file_id, publish }. 초안 · 검토 요청 상태에서만. */
export const POST = route(async (req, ctx) => {
  const doc = await loadDocFor(await requireUser(), await paramInt(ctx, "id"));
  if (!["draft", "notified"].includes(doc.state)) bad("초안 · 검토 요청 상태에서만 바꿀 수 있습니다", 409);
  const b = await body<{ file_id: number; publish: boolean }>(req);
  const r = await sql`
    UPDATE sb.mail_attachments SET publish = ${Boolean(b.publish)}
    WHERE id = ${Number(b.file_id)} AND thread_id = ${doc.mail_thread_id ?? -1} AND storage_path IS NOT NULL RETURNING id`;
  if (!r.length) bad("이 문서의 첨부가 아니거나 아직 올리지 않은 파일입니다", 404);
  return { ok: true };
});
