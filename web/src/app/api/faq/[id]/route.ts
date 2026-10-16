import { HttpError, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { issueUrlMaker } from "@/server/issuetrack/client";
import { DISCLOSURES } from "@/server/issuetrack/sb";
import { attachmentsOf, getArticle, KINDS, relatedArticles, SPACES } from "@/server/kb/search";

export const dynamic = "force-dynamic";

/** FAQ 문서 하나 — 본문 · 첨부 · 관련 문서. 열 때마다 조회수를 하나 올린다. */
export const GET = route(async (_req, ctx) => {
  await requireUser();
  const a = await getArticle(await paramInt(ctx, "id"), { countView: true });
  if (!a) throw new HttpError(404, "문서가 없거나 내려진 문서입니다");
  const url = await issueUrlMaker();
  return {
    article: { ...a, body_text: undefined },
    issues: a.redmine_issue_ids.map((n) => ({ id: n, url: url(n) })),
    attachments: await attachmentsOf(a.id),
    related: await relatedArticles(a),
    labels: { kind: KINDS, space: SPACES, disclosure: DISCLOSURES },
  };
});
