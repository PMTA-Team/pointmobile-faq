import { NextResponse } from "next/server";
import { body } from "@/server/http";
import { requireUser } from "@/server/session";
import { HttpError } from "@/server/http";
import { hasKey } from "@/server/claude";
import { answer, type WikiEvent } from "@/server/kb/wiki";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * LLM Wiki 질문 — { question, history: [{q, a}] } → Server-Sent Events.
 *   event: status | text | done | error  (data = JSON)
 * Claude 가 FAQ 를 찾아 읽는 동안 'FAQ 검색: …' 을, 답을 쓰는 동안 글자를 흘려보내고, 끝에 인용 · 출처를 보낸다.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    const err = e as HttpError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 401 });
  }
  if (!hasKey()) return NextResponse.json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다" }, { status: 503 });
  const b = await body<{ question: string; history: { q: string; a: string }[] }>(req);
  const question = (b.question ?? "").trim().slice(0, 2000);
  if (!question) return NextResponse.json({ error: "질문을 입력하세요" }, { status: 400 });
  const history = Array.isArray(b.history)
    ? b.history.slice(-4).map((h) => ({ q: String(h.q ?? "").slice(0, 2000), a: String(h.a ?? "").slice(0, 6000) }))
    : [];

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: WikiEvent) => {
        try {
          controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch { /* 브라우저가 끊었다 */ }
      };
      try {
        await answer({ question, history, user, emit, signal: req.signal });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        try { controller.close(); } catch { /* 이미 닫힘 */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
