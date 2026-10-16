import { encryptSecret } from "@/server/crypto";
import { sql } from "@/server/db";
import { bad, body, param, route } from "@/server/http";
import { forget } from "@/server/memo";
import { requireAdmin } from "@/server/session";
import { sharedUid, WEB_FIXED } from "../../../_shared";

export const dynamic = "force-dynamic";

export const POST = route(async (req, ctx) => {
  await requireAdmin();
  const target = await param(ctx, "target");
  const cfg = WEB_FIXED[target];
  if (!cfg) bad("모르는 대상입니다", 404);
  const b = await body<{ username: string; password: string }>(req);
  const username = String(b.username ?? "").trim();
  const pw = String(b.password ?? "");
  if (!username) bad("아이디를 입력하세요");
  const sid = await sharedUid();
  const [row] = await sql`SELECT id FROM sb.web_credentials WHERE user_id = ${sid} AND target = ${target}`;
  if (!row) {
    if (!pw) bad("최초 등록 시 비밀번호가 필요합니다");
    await sql`
      INSERT INTO sb.web_credentials (user_id, target, base_url, username, encrypted_password)
      VALUES (${sid}, ${target}, ${cfg.base_url}, ${username}, ${encryptSecret(pw)})`;
  } else if (pw) {
    await sql`
      UPDATE sb.web_credentials SET base_url = ${cfg.base_url}, username = ${username},
        encrypted_password = ${encryptSecret(pw)}, updated_at = now()
      WHERE user_id = ${sid} AND target = ${target}`;
  } else {
    await sql`
      UPDATE sb.web_credentials SET base_url = ${cfg.base_url}, username = ${username}, updated_at = now()
      WHERE user_id = ${sid} AND target = ${target}`;
  }
  forget("redmine:");
  return { ok: true, message: `${cfg.label} 계정을 저장했습니다` };
});
