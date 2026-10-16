import { sql } from "@/server/db";
import { bad, body, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** LLM Wiki 답 평가 — { rating: 1 | -1, comment? }. 본인 질문만. 👎 · 못 찾음은 새 FAQ 문서 거리다. */
export const POST = route(async (req, ctx) => {
  const u = await requireUser();
  const id = await paramInt(ctx, "id");
  const b = await body<{ rating: number; comment: string }>(req);
  const rating = b.rating === -1 ? -1 : 1;
  const comment = String(b.comment ?? "").trim().slice(0, 2000) || null;
  const rows = await sql`UPDATE sb.qa_logs SET rating = ${rating}, comment = COALESCE(${comment}, comment)
                         WHERE id = ${id} AND user_id = ${u.id} RETURNING id`;
  if (!rows.length) bad("질문 기록이 없습니다", 404);
  return { ok: true, message: "고맙습니다 — 답을 고치는 데 씁니다" };
});
