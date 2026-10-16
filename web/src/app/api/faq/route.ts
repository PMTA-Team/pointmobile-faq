import { q, qInt, route } from "@/server/http";
import { memo } from "@/server/memo";
import { requireUser } from "@/server/session";
import { DISCLOSURES } from "@/server/issuetrack/sb";
import { KINDS, searchArticles, SPACES } from "@/server/kb/search";

export const dynamic = "force-dynamic";

/**
 * FAQ 검색 — 확정된 SB 문서와 Confluence 에서 옮긴 문서(sb.kb_articles).
 *   ?q=검색어(공백 = 모두 포함, OR, -빼기, "구", #이슈번호) &kind= &space= &product= &disclosure= &sort=relevance|recent &limit= &offset=
 * 로그인한 사람은 공개 등급과 상관없이 모두 본다(사내 기록 · 공개 등급은 표시만).
 * 같은 조건의 결과는 60초 기억한다 — 문서는 자주 바뀌지 않고, 확정 · 확정 취소는 그 자리에서 기억을 지운다.
 */
export const GET = route(async (req) => {
  await requireUser();
  const sort = q(req, "sort") === "recent" ? "recent" : "relevance";
  const opts = {
    q: q(req, "q").trim(), kind: q(req, "kind") || undefined, space: q(req, "space") || undefined,
    product: q(req, "product") || undefined, disclosure: q(req, "disclosure") || undefined, sort,
    limit: qInt(req, "limit", 20), offset: qInt(req, "offset", 0),
  } as const;
  const r = await memo(`faq:search:${JSON.stringify(opts)}`, 60_000, () => searchArticles(opts));
  return { ...r, labels: { kind: KINDS, space: SPACES, disclosure: DISCLOSURES } };
});
