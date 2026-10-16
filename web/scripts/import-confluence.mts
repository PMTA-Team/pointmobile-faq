/**
 * Confluence(SB · Knowledge Articles · Troubleshooting) → sb.kb_articles · sb.kb_attachments.
 *
 *   1) 백업(pg_dump .sql)에서 필요한 표를 SQLite 로 뽑는다(별도 도구 — docs/FAQ_PLAN.md)
 *   2) DATABASE_URL=… node --import tsx scripts/import-confluence.mts <confluence.sqlite>
 *
 * 원본 페이지 id(source_page_id) · 첨부 id(source_attachment_id)로 덮어써서, 다시 돌려도 같은 결과가 된다.
 * 본문의 자리표시({{att:…}} · {{page:…}})는 새 id 가 정해진 뒤 /api/kb/files/<id> · /faq/<id> 로 바꾼다.
 */
import postgres from "postgres";
import { CONFLUENCE_BASE } from "./confluence/convert.mts";
import { load } from "./confluence/load.mts";

const SQLITE = process.argv[2];
if (!SQLITE) throw new Error("confluence.sqlite 경로를 주세요");
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 2 });
const BATCH = 100;

const { articles, attachments, byTitle } = load(SQLITE);
const real = articles.filter((a) => !a.navOnly);
console.log(`문서 ${real.length} · 첨부 ${attachments.length}`);

// 1) 문서
const articleId = new Map<number, number>();          // Confluence pageId → kb_articles.id
for (let i = 0; i < real.length; i += BATCH) {
  const rows = real.slice(i, i + BATCH).map((a) => ({
    kind: a.kind, title: a.title, category: a.category, labels: a.labels, applies_to: a.appliesTo, products: a.products,
    disclosure: a.disclosure, body_html: a.html, body_text: a.text, raw_storage: a.raw, summary: a.summary || null,
    source: "confluence", source_space: a.spaceKey, source_page_id: a.pageId, source_url: a.sourceUrl,
    redmine_issue_ids: a.redmineIds, state: "published", author: a.author, created_at: a.createdAt, updated_at: a.updatedAt,
  }));
  const cols = Object.keys(rows[0]) as (keyof (typeof rows)[number])[];
  const res = await sql`
    INSERT INTO sb.kb_articles ${sql(rows as never, cols as never)}
    ON CONFLICT (source_page_id) DO UPDATE SET
      kind = EXCLUDED.kind, title = EXCLUDED.title, category = EXCLUDED.category, labels = EXCLUDED.labels,
      applies_to = EXCLUDED.applies_to, products = EXCLUDED.products, disclosure = EXCLUDED.disclosure,
      body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text, raw_storage = EXCLUDED.raw_storage,
      summary = COALESCE(sb.kb_articles.summary, EXCLUDED.summary), source_url = EXCLUDED.source_url,
      redmine_issue_ids = EXCLUDED.redmine_issue_ids, author = EXCLUDED.author,
      created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
    RETURNING id, source_page_id`;
  for (const r of res) articleId.set(Number(r.source_page_id), r.id);
  process.stdout.write(`\r문서 ${Math.min(i + BATCH, real.length)}/${real.length}`);
}
console.log();

// 2) 첨부(이관한 문서에 달린 것만)
const attId = new Map<string, number>();              // "pageId|filename" → kb_attachments.id
const atts = attachments.filter((a) => articleId.has(a.pageId));
for (let i = 0; i < atts.length; i += BATCH) {
  const rows = atts.slice(i, i + BATCH).map((a) => ({
    article_id: articleId.get(a.pageId)!, source_attachment_id: a.id, filename: a.filename, media_type: a.mediaType,
    size: a.size, is_image: a.isImage, source_url: a.sourceUrl,
  }));
  const res = await sql`
    INSERT INTO sb.kb_attachments ${sql(rows as never, Object.keys(rows[0]) as never)}
    ON CONFLICT (source_attachment_id) DO UPDATE SET
      article_id = EXCLUDED.article_id, filename = EXCLUDED.filename, media_type = EXCLUDED.media_type,
      size = EXCLUDED.size, is_image = EXCLUDED.is_image, source_url = EXCLUDED.source_url
    RETURNING id, source_attachment_id`;
  const byAtt = new Map(atts.map((a) => [a.id, a]));
  for (const r of res) {
    const a = byAtt.get(Number(r.source_attachment_id))!;
    attId.set(`${a.pageId}|${a.filename}`, r.id);
  }
}
console.log(`첨부 ${atts.length}`);

// 3) 자리표시 → 실제 주소
let unresolvedPage = 0, unresolvedAtt = 0;
const pageHref = (pageId: number | undefined, fallback: string) => {
  const id = pageId ? articleId.get(pageId) : undefined;
  if (id) return `/faq/${id}`;
  unresolvedPage++;
  return pageId ? `${CONFLUENCE_BASE}/pages/viewpage.action?pageId=${pageId}` : fallback;
};
const attHref = (pageId: number | undefined, filename: string) => {
  const id = pageId ? attId.get(`${pageId}|${filename}`) : undefined;
  if (id) return `/api/kb/files/${id}`;
  unresolvedAtt++;
  return pageId ? `${CONFLUENCE_BASE}/download/attachments/${pageId}/${encodeURIComponent(filename)}` : "";
};
const resolve = (html: string) => html
  .replace(/\{\{att:(\d+)\|([^}]*)\}\}/g, (_, p, f) => attHref(Number(p), f))
  .replace(/\{\{attp:([^|}]*)\|([^|}]*)\|([^}]*)\}\}/g, (_, s, t, f) => attHref(byTitle.get(`${s}|${t}`), f))
  .replace(/\{\{pageid:(\d+)\}\}/g, (_, p) => pageHref(Number(p), ""))
  .replace(/\{\{page:([^|}]*)\|([^}]*)\}\}/g, (_, s, t) =>
    pageHref(byTitle.get(`${s}|${t}`), `${CONFLUENCE_BASE}/display/${encodeURIComponent(s)}/${encodeURIComponent(t).replace(/%20/g, "+")}`));

for (let i = 0; i < real.length; i += BATCH) {
  const rows = real.slice(i, i + BATCH).map((a) => ({ id: articleId.get(a.pageId)!, html: resolve(a.html) }));
  await sql`
    UPDATE sb.kb_articles k SET body_html = v.html
    FROM (SELECT * FROM jsonb_to_recordset(${sql.json(rows as never)}) AS x(id int, html text)) v
    WHERE k.id = v.id`;
}
console.log(`링크 · 이미지 바꿈 — 못 찾은 문서 링크 ${unresolvedPage} · 첨부 ${unresolvedAtt}(원본 Confluence 주소로 둠)`);

const [s] = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE body_html LIKE '%{{%')::int AS left
                      FROM sb.kb_articles WHERE source = 'confluence'`;
console.log(`kb_articles(confluence) ${s.n}건 · 자리표시 남은 문서 ${s.left}`);
await sql.end();
