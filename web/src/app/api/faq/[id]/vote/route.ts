import { body, paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { vote } from "@/server/kb/search";

export const dynamic = "force-dynamic";

/** '도움이 됐나요' — { up: true | false }. 많이 읽히고 👎 가 쌓인 문서가 고칠 거리다. */
export const POST = route(async (req, ctx) => {
  await requireUser();
  const b = await body<{ up: boolean }>(req);
  await vote(await paramInt(ctx, "id"), b.up !== false);
  return { ok: true, message: "고맙습니다" };
});
