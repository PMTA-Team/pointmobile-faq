import { NextResponse } from "next/server";
import { sql } from "@/server/db";
import { HttpError, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * FAQ 문서의 첨부 — 본문의 <img src="/api/kb/files/<id>"> 가 여기로 온다.
 * DB(sb.kb_files)에 받아 둔 것은 그대로 주고, 없으면(큰 파일 · 아직 못 받은 것) 원본 Confluence 주소로 보낸다.
 * 로그인한 사람만 — internal 문서의 그림도 있다.
 */
export const GET = route(async (_req, ctx) => {
  await requireUser();
  const id = await paramInt(ctx, "id");
  const [a] = await sql<{ filename: string; media_type: string; source_url: string | null; data: Buffer | null; sha256: string | null }[]>`
    SELECT a.filename, a.media_type, a.source_url, f.data, f.sha256
    FROM sb.kb_attachments a LEFT JOIN sb.kb_files f ON f.attachment_id = a.id
    WHERE a.id = ${id}`;
  if (!a) throw new HttpError(404, "첨부가 없습니다");
  if (!a.data) {
    if (a.source_url) return NextResponse.redirect(a.source_url, 302);
    throw new HttpError(404, "첨부 내용이 없습니다");
  }
  const inline = a.media_type.startsWith("image/") || a.media_type === "application/pdf";
  return new NextResponse(new Uint8Array(a.data), {
    headers: {
      "Content-Type": a.media_type || "application/octet-stream",
      "Content-Length": String(a.data.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      // 내용이 바뀌지 않는다(같은 id = 같은 파일). 브라우저에만 오래 둔다 — 로그인한 사람만 보는 것이라 공용 캐시는 쓰지 않는다.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: `"${a.sha256}"`,
    },
  });
});
