import { sql } from "@/server/db";
import { q, qInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { issueUrlMaker } from "@/server/issuetrack/client";
import { DISCLOSURES, PARTNER_CHOICES } from "@/server/issuetrack/sb";
import { kstIso } from "@/server/time";

export const dynamic = "force-dynamic";

/**
 * FAQ — 담당자가 확정(approved)한 SB 문서. 같은 이슈의 옛 판(superseded)은 빼고 최신 판만.
 * SB 문서 화면과 달리 공용 자료라 로그인한 사람이면 담당자와 상관없이 모두 본다.
 *   ?q=제목 · Applies to · 본문 · #이슈번호   ?disclosure=public|partner|ascp|internal   ?limit=
 */
export const GET = route(async (req) => {
  await requireUser();
  const text = q(req, "q").trim();
  const disclosure = q(req, "disclosure");
  const limit = Math.max(1, Math.min(qInt(req, "limit", 50), 500));

  const base = sql`d.state = 'approved' AND d.superseded = false`;
  let search = sql`TRUE`;
  if (/^#?\d+$/.test(text)) {
    search = sql`d.issue_id = ${Number(text.replace("#", ""))}`;
  } else if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    search = sql`(d.title ILIKE ${like} OR d.applies_to ILIKE ${like} OR d.description_html ILIKE ${like})`;
  }
  const byDisclosure = disclosure in DISCLOSURES ? sql`d.disclosure = ${disclosure}` : sql`TRUE`;

  // 등급별 건수는 검색어만 반영한다 — 칩을 눌러 오가도 숫자가 그대로 보이게.
  const counts = Object.fromEntries(
    (await sql<{ disclosure: string; n: number }[]>`
      SELECT d.disclosure, count(*)::int AS n FROM sb.rm_sb_docs d WHERE ${base} AND ${search} GROUP BY d.disclosure`)
      .map((r) => [r.disclosure, r.n]));
  const [{ total }] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM sb.rm_sb_docs d WHERE ${base} AND ${search} AND ${byDisclosure}`;
  const rows = await sql<{
    id: number; issue_id: number; revision: number; title: string; is_troubleshooting: boolean; disclosure: string;
    applies_to: string | null; description_html: string | null; partners_json: string | null;
    decided_at: Date | null; decided_by: string | null;
  }[]>`
    SELECT d.id, d.issue_id, d.revision, d.title, d.is_troubleshooting, d.disclosure, d.applies_to, d.description_html,
           d.partners_json, d.decided_at, d.decided_by
    FROM sb.rm_sb_docs d
    WHERE ${base} AND ${search} AND ${byDisclosure}
    ORDER BY d.decided_at DESC NULLS LAST, d.id DESC
    LIMIT ${limit}`;

  const url = await issueUrlMaker();
  return {
    total,
    counts,
    disclosures: DISCLOSURES,
    partners: PARTNER_CHOICES,
    items: rows.map((d) => ({
      id: d.id,
      issue_id: d.issue_id,
      revision: d.revision,
      title: d.title || "",
      troubleshooting: Boolean(d.is_troubleshooting),
      disclosure: d.disclosure,
      applies_to: d.applies_to || "",
      description_html: d.description_html || "",
      partners: safeJson(d.partners_json),
      decided_at: kstIso(d.decided_at),
      decided_by: d.decided_by || "",
      issue_url: url(d.issue_id),
    })),
  };
});

function safeJson(s: string | null): string[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
