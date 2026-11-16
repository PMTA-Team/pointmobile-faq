import { paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { loadDocFor } from "@/server/issuetrack/api";
import { sourceText } from "@/server/issuetrack/sb";
import { specificsOf } from "@/server/issuetrack/specifics";

export const dynamic = "force-dynamic";

/** 원문(메일 · 이슈)에서 뽑은 '그대로 옮겨야 할 것' — 화면이 지금 초안과 대조해 빠진 것을 보여 준다. */
export const GET = route(async (_req, ctx) => {
  const doc = await loadDocFor(await requireUser(), await paramInt(ctx, "id"));
  const src = await sourceText({ source: doc.source, issue_id: doc.issue_id, mail_thread_id: doc.mail_thread_id });
  return { items: specificsOf(src) };
});
