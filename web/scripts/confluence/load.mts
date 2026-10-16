/** 백업에서 뽑은 SQLite(confluence.sqlite)를 읽어 이관할 문서 목록을 만든다. */
import Database from "better-sqlite3";
import { appliesTo, convert, disclosureOf, kindOf, products, redmineIds, CONFLUENCE_BASE } from "./convert.mts";

export type SrcAttachment = { id: number; pageId: number; filename: string; mediaType: string; size: number; isImage: boolean; sourceUrl: string };
export type SrcArticle = {
  pageId: number; spaceKey: string; title: string; category: string; labels: string[]; kind: string; disclosure: string;
  appliesTo: string; products: string[]; redmineIds: number[]; author: string; createdAt: Date; updatedAt: Date;
  html: string; text: string; raw: string; navOnly: boolean; unknownMacros: string[]; sourceUrl: string; summary: string;
};

// Confluence DB 시각은 서버 지역 시각(KST)이다.
const kst = (s: string | null) => (s ? new Date(s.replace(" ", "T") + "+09:00") : new Date(0));

export function load(path: string) {
  const db = new Database(path, { readonly: true });
  const spaces = new Map<number, { key: string; homepage: number }>();
  for (const s of db.prepare("SELECT spaceid, spacekey, homepage FROM spaces").all() as { spaceid: number; spacekey: string; homepage: number }[]) {
    spaces.set(s.spaceid, { key: s.spacekey, homepage: s.homepage });
  }
  const users = new Map((db.prepare("SELECT user_key, username FROM users").all() as { user_key: string; username: string }[])
    .map((u) => [u.user_key, u.username]));
  const content = new Map((db.prepare("SELECT contentid, title, parentid FROM content WHERE contenttype IN ('PAGE','BLOGPOST') AND prevver IS NULL")
    .all() as { contentid: number; title: string; parentid: number | null }[]).map((c) => [c.contentid, c]));
  const labelsOf = new Map<number, string[]>();
  for (const r of db.prepare(`SELECT cl.contentid, l.name FROM content_label cl JOIN label l USING(labelid)
                              WHERE cl.contentid IN (SELECT contentid FROM target_pages)`).all() as { contentid: number; name: string }[]) {
    (labelsOf.get(r.contentid) ?? labelsOf.set(r.contentid, []).get(r.contentid)!).push(r.name);
  }
  const pages = db.prepare(`SELECT t.contentid, t.title, t.creator, t.creationdate, t.lastmoddate, t.spaceid, t.parentid, b.body
                            FROM target_pages t LEFT JOIN body b ON b.contentid = t.contentid`).all() as {
    contentid: number; title: string; creator: string; creationdate: string; lastmoddate: string; spaceid: number; parentid: number | null; body: string | null;
  }[];

  const articles: SrcArticle[] = [];
  for (const p of pages) {
    const sp = spaces.get(p.spaceid)!;
    if (p.contentid === sp.homepage) continue;                       // 스페이스 첫 페이지
    // 분류 = 상위 페이지 제목들(스페이스 첫 페이지 제외)
    const chain: string[] = [];
    let cur = p.parentid;
    for (let i = 0; cur && i < 8; i++) {
      const c = content.get(cur);
      if (!c || cur === sp.homepage) break;
      chain.unshift(c.title);
      cur = c.parentid;
    }
    const labels = [...new Set(labelsOf.get(p.contentid) ?? [])].sort();
    const conv = convert(p.body ?? "", p.contentid, sp.key);
    const ap = (conv.props.appliesTo || appliesTo(conv.text)).slice(0, 300);
    articles.push({
      pageId: p.contentid, spaceKey: sp.key, title: p.title.trim(), category: chain.join(" › "), labels,
      kind: kindOf(sp.key, labels), disclosure: disclosureOf(labels), appliesTo: ap,
      products: products(p.title, ap, labels.filter((l) => /^pm\d/i.test(l)).join(" ")),
      redmineIds: redmineIds(conv.html, conv.text), author: conv.author || users.get(p.creator) || "",
      createdAt: kst(p.creationdate), updatedAt: kst(p.lastmoddate), html: conv.html, text: conv.text, raw: p.body ?? "",
      summary: conv.props.summary ?? "",
      // 목록 매크로뿐인 페이지 · 내용이 거의 없는 분류 페이지('Open' · 'Internal') · SB 양식 예시는 문서로 옮기지 않는다
      navOnly: conv.navOnly || conv.text.replace(/\s+/g, "").length < 20 || (sp.key === "SB" && p.title.trim() === "Example"),
      unknownMacros: conv.unknownMacros,
      sourceUrl: `${CONFLUENCE_BASE}/pages/viewpage.action?pageId=${p.contentid}`,
    });
  }

  const attachments = (db.prepare(`SELECT a.contentid, a.title, a.pageid,
      (SELECT stringval FROM props WHERE contentid = a.contentid AND name = 'MEDIA_TYPE') AS mt,
      (SELECT longval FROM props WHERE contentid = a.contentid AND name = 'FILESIZE') AS size
    FROM target_atts a`).all() as { contentid: number; title: string; pageid: number; mt: string | null; size: number | null }[])
    .map((a): SrcAttachment => ({
      id: a.contentid, pageId: a.pageid, filename: a.title, mediaType: a.mt ?? "", size: a.size ?? 0,
      isImage: (a.mt ?? "").startsWith("image/"),
      sourceUrl: `${CONFLUENCE_BASE}/download/attachments/${a.pageid}/${encodeURIComponent(a.title)}`,
    }));
  // 제목으로 페이지 찾기(링크 자리표시용) — 같은 스페이스 + 같은 제목
  const byTitle = new Map<string, number>();
  for (const p of pages) byTitle.set(`${spaces.get(p.spaceid)!.key}|${p.title.trim()}`, p.contentid);
  db.close();
  return { articles, attachments, byTitle };
}
