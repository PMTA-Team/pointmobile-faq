/**
 * 업로드 → FAQ — SB 문서를 확정하면 sb.kb_articles 에 '해결 사례'로 넣고, 확정을 취소하면 내린다(archived).
 * 같은 이슈가 다시 열렸다가 해결돼 새 판을 확정하면, 예전 판의 FAQ 문서는 보관(archived)으로 돌린다.
 */
import { sql } from "../db";
import { forget } from "../memo";
import { issueUrlMaker } from "../issuetrack/client";
import { htmlToText, products } from "./text";

export async function publishSbDoc(docId: number): Promise<number | null> {
  const [d] = await sql<{
    id: number; issue_id: number; title: string; disclosure: string; applies_to: string | null; description_html: string | null;
    assignee_name: string | null; decided_by: string | null; decided_at: Date | null; generated_at: Date | null;
  }[]>`
    SELECT id, issue_id, title, disclosure, applies_to, description_html, assignee_name, decided_by, decided_at, generated_at
    FROM sb.rm_sb_docs WHERE id = ${docId} AND state = 'approved'`;
  if (!d) return null;
  const url = (await issueUrlMaker())(d.issue_id);
  const html = d.description_html || "";
  const applies = d.applies_to || "";
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO sb.kb_articles (kind, title, category, labels, applies_to, products, disclosure, body_html, body_text,
      source, source_space, source_url, sb_doc_id, redmine_issue_ids, state, author, approved_by, approved_at, created_at, updated_at)
    VALUES ('resolution', ${d.title}, 'Solution Buffer', ${["sb"]}, ${applies}, ${products(d.title, applies)}, ${d.disclosure},
      ${html}, ${htmlToText(html)}, 'sb', 'SB', ${url}, ${d.id}, ${[d.issue_id]}, 'published', ${d.assignee_name || ""},
      ${d.decided_by}, ${d.decided_at ?? new Date()}, ${d.generated_at ?? new Date()}, now())
    ON CONFLICT (sb_doc_id) DO UPDATE SET
      title = EXCLUDED.title, applies_to = EXCLUDED.applies_to, products = EXCLUDED.products, disclosure = EXCLUDED.disclosure,
      body_html = EXCLUDED.body_html, body_text = EXCLUDED.body_text, source_url = EXCLUDED.source_url, state = 'published',
      author = EXCLUDED.author, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, updated_at = now()
    RETURNING id`;
  forget("faq:");      // FAQ 검색 · 문서 기억을 지워 바로 보이게
  // 같은 이슈의 예전 판 — 이 앱에서 확정한 것만(Confluence 이관분은 사람이 판단할 기록이라 그대로 둔다)
  await sql`
    UPDATE sb.kb_articles SET state = 'archived', updated_at = now()
    WHERE source = 'sb' AND state = 'published' AND sb_doc_id <> ${d.id} AND ${d.issue_id} = ANY(redmine_issue_ids)`;
  return row.id;
}

/** 확정 취소 — FAQ 에서 내린다(지우지 않는다: 열람 · 평가 기록이 남는다). */
export async function unpublishSbDoc(docId: number): Promise<void> {
  await sql`UPDATE sb.kb_articles SET state = 'archived', updated_at = now() WHERE sb_doc_id = ${docId}`;
  forget("faq:");
}
