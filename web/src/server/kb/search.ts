/**
 * FAQ 검색 · 문서 — sb.kb_articles(state = 'published').
 *
 * 검색은 PGroonga(제목 · 적용 모델 · 본문, 한국어 · 영어 2글자 단위 색인)로 하고, 제목에 맞으면 위로 올린다.
 * '#33526' 은 Redmine 이슈 번호로 찾는다. PGroonga 가 없는 DB(로컬 PostgreSQL)에서는 ILIKE 로 대신한다.
 * FAQ 화면과 LLM Wiki 의 검색 도구가 같은 함수를 쓴다.
 */
import { sql } from "../db";
import { kstIso } from "../time";

export const KINDS: Record<string, string> = {
  resolution: "해결 사례",
  troubleshooting: "Troubleshooting",
  how_to: "How-to",
  guide: "가이드",
};
export const SPACES: Record<string, string> = {
  SB: "Solution Buffer",
  faq: "Knowledge Articles",
  TRguide: "Troubleshooting",
};

let _groonga: boolean | null = null;
async function hasGroonga(): Promise<boolean> {
  if (_groonga === null) {
    const [r] = await sql`SELECT 1 AS ok FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                          WHERE e.extname = 'pgroonga' AND n.nspname = 'sb'`;
    _groonga = Boolean(r);
  }
  return _groonga;
}

export type SearchOpts = {
  q?: string; kind?: string; product?: string; space?: string; disclosure?: string;
  sort?: "relevance" | "recent"; limit?: number; offset?: number;
};

export type SearchHit = {
  id: number; title: string; kind: string; disclosure: string; applies_to: string; products: string[];
  category: string; source_space: string; redmine_issue_ids: number[]; updated_at: string; snippets: string[]; score: number;
};

/** PGroonga 질의 문법(공백 = 그리고, OR, -빼기, "구") 그대로 쓰되, 깨진 따옴표 · 괄호는 걷어 낸다. */
function cleanQuery(q: string): string {
  let s = q.replace(/[()]/g, " ").trim();
  if ((s.match(/"/g) ?? []).length % 2) s = s.replace(/"/g, " ");
  return s.replace(/\s+/g, " ");
}

/**
 * 검색. 단어를 모두 포함한 문서가 없으면 단어 중 하나라도 맞는 문서를 관련도순으로 준다(loose = true) —
 * '연결 끊김' 처럼 문서와 표현이 조금 다른 질문도 빈손으로 끝나지 않게.
 */
export async function searchArticles(o: SearchOpts) {
  const first = await searchOnce(o);
  const q = cleanQuery(o.q ?? "");
  const words = q.split(" ").filter((w) => w && !/^(OR|-.*)$/i.test(w));
  if (first.total || words.length < 2 || /\bOR\b|"/.test(q)) return { ...first, loose: false };
  return { ...(await searchOnce({ ...o, q: words.join(" OR ") })), loose: true };
}

async function searchOnce(o: SearchOpts) {
  const q = cleanQuery(o.q ?? "");
  const limit = Math.max(1, Math.min(o.limit ?? 20, 100));
  const offset = Math.max(0, o.offset ?? 0);
  const groonga = await hasGroonga();
  const issue = q.match(/^#?(\d{4,6})$/);

  // 검색어 조건(걸러 보기 건수에도 같이 쓴다)
  let match = sql`TRUE`;
  let score = sql`0::float8`;
  let snippet = sql`ARRAY[]::text[]`;
  if (issue) {
    match = sql`${Number(issue[1])} = ANY(k.redmine_issue_ids)`;
  } else if (q && groonga) {
    match = sql`ARRAY[k.title, k.applies_to, k.body_text] OPERATOR(sb.&@~) ${q}`;
    score = sql`sb.pgroonga_score(k.tableoid, k.ctid) + CASE WHEN k.title OPERATOR(sb.&@~) ${q} THEN 50 ELSE 0 END`;
    snippet = sql`sb.pgroonga_snippet_html(k.body_text, sb.pgroonga_query_extract_keywords(${q}), 160)`;
  } else if (q) {
    const words = q.split(" ").filter(Boolean).slice(0, 8);
    for (const w of words) {
      const like = `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      match = sql`${match} AND (k.title ILIKE ${like} OR k.applies_to ILIKE ${like} OR k.body_text ILIKE ${like})`;
    }
    score = sql`CASE WHEN k.title ILIKE ${`%${q}%`} THEN 50 ELSE 1 END`;
  }

  const base = sql`k.state = 'published' AND ${match}`;
  const f = (col: "kind" | "source_space" | "disclosure", v?: string) => (v ? sql`AND k.${sql(col)} = ${v}` : sql``);
  const fp = o.product ? sql`AND ${o.product} = ANY(k.products)` : sql``;
  const where = sql`${base} ${f("kind", o.kind)} ${f("source_space", o.space)} ${f("disclosure", o.disclosure)} ${fp}`;
  const order = o.sort === "recent" || !q ? sql`k.updated_at DESC, k.id DESC` : sql`score DESC, k.updated_at DESC`;

  const [rows, [{ total }], facets] = await Promise.all([
    sql<(Omit<SearchHit, "updated_at"> & { updated_at: Date })[]>`
      SELECT k.id, k.title, k.kind, k.disclosure, k.applies_to, k.products, k.category, k.source_space, k.redmine_issue_ids,
             k.updated_at, ${score} AS score, ${snippet} AS snippets
      FROM sb.kb_articles k WHERE ${where}
      ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    sql<{ total: number }[]>`SELECT count(*)::int AS total FROM sb.kb_articles k WHERE ${where}`,
    // 걸러 보기 건수 — 검색어만 반영(다른 걸러 보기를 눌러도 숫자가 그대로 보이게)
    sql<{ dim: string; key: string; n: number }[]>`
      SELECT 'kind' AS dim, k.kind AS key, count(*)::int AS n FROM sb.kb_articles k WHERE ${base} GROUP BY 2
      UNION ALL SELECT 'space', k.source_space, count(*)::int FROM sb.kb_articles k WHERE ${base} GROUP BY 2
      UNION ALL SELECT 'disclosure', k.disclosure, count(*)::int FROM sb.kb_articles k WHERE ${base} GROUP BY 2
      UNION ALL (SELECT 'product', p, count(*)::int FROM sb.kb_articles k, unnest(k.products) p WHERE ${base}
                 GROUP BY 2 ORDER BY 3 DESC LIMIT 30)`,
  ]);

  const fac: Record<string, Record<string, number>> = { kind: {}, space: {}, disclosure: {}, product: {} };
  for (const r of facets) if (r.key) fac[r.dim][r.key] = r.n;
  return {
    total,
    facets: fac,
    items: rows.map((r): SearchHit => ({
      ...r, score: Number(r.score), updated_at: kstIso(r.updated_at),
      snippets: (r.snippets ?? []).slice(0, 2),
    })),
  };
}

export type Article = {
  id: number; kind: string; title: string; category: string; labels: string[]; applies_to: string; products: string[];
  disclosure: string; body_html: string; body_text: string; summary: string | null; source: string; source_space: string | null;
  source_url: string | null; sb_doc_id: number | null; redmine_issue_ids: number[]; author: string; approved_by: string | null;
  created_at: string; updated_at: string; approved_at: string; view_count: number; helpful_up: number; helpful_down: number;
};

export async function getArticle(id: number, opts: { countView?: boolean } = {}): Promise<Article | null> {
  const rows = opts.countView
    ? await sql`UPDATE sb.kb_articles SET view_count = view_count + 1 WHERE id = ${id} AND state = 'published' RETURNING *`
    : await sql`SELECT * FROM sb.kb_articles WHERE id = ${id} AND state = 'published'`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, title: r.title, category: r.category, labels: r.labels, applies_to: r.applies_to, products: r.products,
    disclosure: r.disclosure, body_html: r.body_html, body_text: r.body_text, summary: r.summary, source: r.source,
    source_space: r.source_space, source_url: r.source_url, sb_doc_id: r.sb_doc_id, redmine_issue_ids: r.redmine_issue_ids,
    author: r.author, approved_by: r.approved_by, created_at: kstIso(r.created_at), updated_at: kstIso(r.updated_at),
    approved_at: kstIso(r.approved_at), view_count: r.view_count, helpful_up: r.helpful_up, helpful_down: r.helpful_down,
  };
}

export async function attachmentsOf(id: number) {
  return sql<{ id: number; filename: string; media_type: string; size: number; is_image: boolean; stored: boolean }[]>`
    SELECT a.id, a.filename, a.media_type, a.size, a.is_image,
           (a.storage_path IS NOT NULL OR EXISTS (SELECT 1 FROM sb.kb_files f WHERE f.attachment_id = a.id)) AS stored
    FROM sb.kb_attachments a WHERE a.article_id = ${id} ORDER BY a.is_image, a.filename`;
}

/** 관련 문서 — 같은 모델 · 라벨이 많이 겹치는 순(같은 이슈를 다룬 문서는 맨 앞). */
export async function relatedArticles(a: Article, limit = 6) {
  return sql<{ id: number; title: string; kind: string; disclosure: string; overlap: number }[]>`
    SELECT k.id, k.title, k.kind, k.disclosure,
           (cardinality(ARRAY(SELECT unnest(k.products) INTERSECT SELECT unnest(${a.products}::text[]))) * 2
            + cardinality(ARRAY(SELECT unnest(k.labels) INTERSECT SELECT unnest(${a.labels}::text[])))
            + CASE WHEN k.redmine_issue_ids && ${a.redmine_issue_ids}::int[] THEN 10 ELSE 0 END)::int AS overlap
    FROM sb.kb_articles k
    WHERE k.state = 'published' AND k.id <> ${a.id}
      AND (k.products && ${a.products}::text[] OR k.labels && ${a.labels.filter((l) => !["sb", "faq", "basic", "confidential", "partner", "posted"].includes(l))}::text[]
           OR k.redmine_issue_ids && ${a.redmine_issue_ids}::int[])
    ORDER BY overlap DESC, k.updated_at DESC LIMIT ${limit}`;
}

export async function vote(id: number, up: boolean) {
  await sql`UPDATE sb.kb_articles SET ${up ? sql`helpful_up = helpful_up + 1` : sql`helpful_down = helpful_down + 1`} WHERE id = ${id}`;
}
