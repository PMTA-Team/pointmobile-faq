import { NextResponse } from "next/server";
import { sql } from "@/server/db";
import { temporaryLink } from "@/server/dropbox";
import { HttpError, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * 메일 첨부 다운로드 — Dropbox 4시간짜리 임시 직링크로 보낸다(로그인한 사람만).
 * 링크는 3시간 반 동안 DB 에 두고 다시 쓴다.
 */
export const GET = route(async (_req, ctx) => {
  await requireUser();
  const id = await paramInt(ctx, "id");
  const [a] = await sql<{ storage_path: string | null; link_cache: string | null; link_expires: Date | null }[]>`
    SELECT storage_path, link_cache, link_expires FROM sb.mail_attachments WHERE id = ${id}`;
  if (!a) throw new HttpError(404, "첨부가 없습니다");
  if (!a.storage_path) throw new HttpError(404, "아직 Dropbox 에 올리지 않은 첨부입니다");
  let link = a.link_cache && a.link_expires && a.link_expires.getTime() > Date.now() + 60_000 ? a.link_cache : "";
  if (!link) {
    link = await temporaryLink(a.storage_path);
    await sql`UPDATE sb.mail_attachments SET link_cache = ${link}, link_expires = now() + interval '210 minutes' WHERE id = ${id}`;
  }
  return NextResponse.redirect(link, { status: 302, headers: { "Cache-Control": "private, max-age=600" } });
});
