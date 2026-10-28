import { paramInt, route } from "@/server/http";
import { requireUser } from "@/server/session";
import { loadDocFor, threadMessages } from "@/server/issuetrack/api";

export const dynamic = "force-dynamic";

/** 메일 문서의 원문 스레드(사람이 주고받은 메일, 인용문 · 서명을 걷어낸 본문). Redmine 문서면 빈 목록. */
export const GET = route(async (_req, ctx) => {
  const doc = await loadDocFor(await requireUser(), await paramInt(ctx, "id"));
  return { messages: doc.mail_thread_id ? await threadMessages(doc.mail_thread_id) : [] };
});
