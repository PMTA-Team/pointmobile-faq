import { q, qInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { DISCLOSURES } from "@/server/issuetrack/sb";
import { KINDS, searchArticles, SPACES } from "@/server/kb/search";

export const dynamic = "force-dynamic";

/**
 * FAQ 검색 — 확정된 SB 문서와 Confluence 에서 옮긴 문서(sb.kb_articles).
 *   ?q=검색어(공백 = 모두 포함, OR, -빼기, "구", #이슈번호) &kind= &space= &product= &disclosure= &sort=relevance|recent &limit= &offset=
 * 로그인한 사람은 공개 등급과 상관없이 모두 본다(사내 기록 · 공개 등급은 표시만).
 */
export const GET = route(async (req) => {
  await requireUser();
  const sort = q(req, "sort") === "recent" ? "recent" : "relevance";
  const r = await searchArticles({
    q: q(req, "q"), kind: q(req, "kind") || undefined, space: q(req, "space") || undefined,
    product: q(req, "product") || undefined, disclosure: q(req, "disclosure") || undefined, sort,
    limit: qInt(req, "limit", 20), offset: qInt(req, "offset", 0),
  });
  return { ...r, labels: { kind: KINDS, space: SPACES, disclosure: DISCLOSURES } };
});
