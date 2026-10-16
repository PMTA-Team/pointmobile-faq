import { after } from "next/server";
import { sql } from "@/server/db";
import { HttpError, paramInt, route } from "@/server/http";
import { memo } from "@/server/memo";
import { requireUser } from "@/server/session";
import { issueUrlMaker } from "@/server/issuetrack/client";
import { DISCLOSURES } from "@/server/issuetrack/sb";
import { attachmentsOf, getArticle, KINDS, relatedArticles, SPACES } from "@/server/kb/search";

export const dynamic = "force-dynamic";

async function detail(id: number) {
  const a = await getArticle(id);
  if (!a) return null;
  const [url, attachments, related] = await Promise.all([issueUrlMaker(), attachmentsOf(a.id), relatedArticles(a)]);
  return {
    article: { ...a, body_text: undefined },
    issues: a.redmine_issue_ids.map((n) => ({ id: n, url: url(n) })),
    attachments,
    related,
    labels: { kind: KINDS, space: SPACES, disclosure: DISCLOSURES },
  };
}

/**
 * FAQ 문서 하나 — 본문 · 첨부 · 관련 문서. 60초 기억한다(확정 · 확정 취소는 그 자리에서 지운다).
 * 조회수는 응답을 보낸 뒤에 올린다 — 기다리지 않게.
 */
export const GET = route(async (_req, ctx) => {
  await requireUser();
  const id = await paramInt(ctx, "id");
  const d = await memo(`faq:doc:${id}`, 60_000, () => detail(id));
  if (!d) throw new HttpError(404, "문서가 없거나 내려진 문서입니다");
  after(() => sql`UPDATE sb.kb_articles SET view_count = view_count + 1 WHERE id = ${id}`.then(() => {}));
  return d;
});
