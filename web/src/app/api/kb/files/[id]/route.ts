import { NextResponse } from "next/server";
import { sql } from "@/server/db";
import { temporaryLink } from "@/server/dropbox";
import { HttpError, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * FAQ 문서의 첨부 — 본문의 <img src="/api/kb/files/<id>"> · 첨부 목록이 여기로 온다. 로그인한 사람만.
 *   1) Dropbox 에 올린 것(storage_path) → 4시간짜리 임시 직링크로 보낸다(큰 OS 파일도 Vercel 을 거치지 않는다).
 *      링크는 3시간 반 동안 DB 에 두고 다시 쓴다 — 그림이 많은 문서에서 볼 때마다 Dropbox 에 묻지 않게.
 *   2) 아직 DB(sb.kb_files)에 있는 것 → 그대로 준다.
 *   3) 그것도 없으면 원본 Confluence 주소로(사내 Confluence 로그인이 필요하다).
 */
export const GET = route(async (_req, ctx) => {
  await requireUser();
  const id = await paramInt(ctx, "id");
  const [a] = await sql<{ filename: string; media_type: string; source_url: string | null; storage_path: string | null;
                          link_cache: string | null; link_expires: Date | null }[]>`
    SELECT filename, media_type, source_url, storage_path, link_cache, link_expires FROM sb.kb_attachments WHERE id = ${id}`;
  if (!a) throw new HttpError(404, "첨부가 없습니다");

  if (a.storage_path) {
    let link = a.link_cache && a.link_expires && a.link_expires.getTime() > Date.now() + 60_000 ? a.link_cache : "";
    if (!link) {
      link = await temporaryLink(a.storage_path);
      await sql`UPDATE sb.kb_attachments SET link_cache = ${link}, link_expires = now() + interval '210 minutes' WHERE id = ${id}`;
    }
    return NextResponse.redirect(link, { status: 302, headers: { "Cache-Control": "private, max-age=600" } });
  }

  const [f] = await sql<{ data: Buffer; sha256: string }[]>`SELECT data, sha256 FROM sb.kb_files WHERE attachment_id = ${id}`;
  if (f) {
    const inline = a.media_type.startsWith("image/") || a.media_type === "application/pdf";
    return new NextResponse(new Uint8Array(f.data), {
      headers: {
        "Content-Type": a.media_type || "application/octet-stream",
        "Content-Length": String(f.data.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: `"${f.sha256}"`,
      },
    });
  }
  if (a.source_url) return NextResponse.redirect(a.source_url, 302);
  throw new HttpError(404, "첨부 내용이 없습니다");
});
