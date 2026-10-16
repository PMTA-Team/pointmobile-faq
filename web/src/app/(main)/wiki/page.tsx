"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { api, useApi } from "@/lib/api";
import { kst } from "@/lib/issues";
import { Card, cx, Empty, PageHead } from "@/components/ui";
import { DisclosureTag } from "@/components/issues/SbDocPanel";
import { RichStyle } from "@/components/issues/RichEditor";

type Source = { n: number; id: number; title: string; disclosure: string; quotes: string[] };
type Block = { text: string; cites: number[] };
type Turn = {
  q: string; status: string[]; streaming: string; blocks: Block[] | null; sources: Source[];
  found: boolean | null; error: string; qaId: number | null; rated: 0 | 1 | -1; busy: boolean;
};
type Log = { id: number; username: string; question: string; found: boolean | null; rating: number | null; error: string | null; created_at: string };

const EXAMPLES = [
  "PM85 에서 스캐너가 첫 번째 바코드를 못 읽어요",
  "공장 초기화 후 Google 계정 잠금(FRP) 풀려면?",
  "Wi-Fi 가 자꾸 끊기는데 확인할 것들",
  "버그 리포트 파일은 어떻게 뽑나요?",
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 답(인용 블록) → HTML. 원문 HTML 은 막고 마크다운만 그리며, 인용 번호를 FAQ 문서 링크로. */
function renderAnswer(blocks: Block[], sources: Source[]): string {
  const md = blocks.map((b) => esc(b.text) + b.cites.map((n) => `⟦${n}⟧`).join("")).join("");
  const html = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
  return html.replace(/⟦(\d+)⟧/g, (_, n) => {
    const s = sources[Number(n) - 1];
    return s ? `<sup><a href="/faq/${s.id}" class="cite" title="${esc(s.title)}">[${n}]</a></sup>` : "";
  });
}
const renderStreaming = (text: string) => marked.parse(esc(text), { async: false, gfm: true, breaks: true }) as string;

/** LLM Wiki — 무엇이든 물어보면 Claude 가 FAQ 를 찾아 읽고 출처를 단 해결 가이드를 준다. */
export default function WikiPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const busy = turns.some((t) => t.busy);
  const mine = useApi<{ admin: boolean; items: Log[] }>("/api/wiki/logs?scope=mine&limit=15");
  const gaps = useApi<{ admin: boolean; items: Log[] }>(mine.data?.admin ? "/api/wiki/logs?scope=gaps&limit=15" : null);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns.length]);

  const patch = (i: number, f: (t: Turn) => Partial<Turn>) => setTurns((ts) => ts.map((t, k) => (k === i ? { ...t, ...f(t) } : t)));

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setQ("");
    const history = turns.filter((t) => t.blocks).map((t) => ({ q: t.q, a: (t.blocks ?? []).map((b) => b.text).join("") }));
    const i = turns.length;
    setTurns((ts) => [...ts, { q: text, status: [], streaming: "", blocks: null, sources: [], found: null, error: "", qaId: null, rated: 0, busy: true }]);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const r = await fetch("/api/wiki", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ question: text, history }), signal: ctl.signal,
      });
      if (!r.ok || !r.body) {
        const err = await r.json().catch(() => ({ error: r.statusText }));
        if (r.status === 401) location.href = `/login?next=/wiki`;
        patch(i, () => ({ error: err.error ?? "요청 실패", busy: false }));
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
          if (!data) continue;
          const e = JSON.parse(data);
          if (e.type === "status") patch(i, (t) => ({ status: [...t.status, e.text], streaming: t.streaming ? t.streaming + "\n\n" : "" }));
          else if (e.type === "text") patch(i, (t) => ({ streaming: t.streaming + e.delta }));
          else if (e.type === "done") patch(i, () => ({ blocks: e.blocks, sources: e.sources, found: e.found, qaId: e.qa_id, busy: false }));
          else if (e.type === "error") patch(i, () => ({ error: e.message, qaId: e.qa_id ?? null, busy: false }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") patch(i, () => ({ error: (e as Error).message }));
    } finally {
      patch(i, () => ({ busy: false }));
      mine.reload();
    }
  }

  async function rate(i: number, rating: 1 | -1) {
    const t = turns[i];
    if (!t.qaId) return;
    await api(`/api/wiki/${t.qaId}/feedback`, { method: "POST", body: JSON.stringify({ rating }) }).catch(() => null);
    patch(i, () => ({ rated: rating }));
    gaps.reload();
  }

  return (
    <>
      <RichStyle />
      <style>{`.answer .cite { text-decoration: none; font-weight: 700; margin-left: 1px; } .answer sup { line-height: 0; }`}</style>
      <PageHead title="LLM Wiki" lead="무엇이든 물어보세요. Claude 가 FAQ 를 찾아 읽고, 출처 문서를 단 해결 가이드를 드립니다. FAQ 에 없으면 없다고 답합니다." />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          {turns.length === 0 && (
            <Card>
              <div className="mb-2 text-[13px] font-semibold text-ink-2">이렇게 물어보세요</div>
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((x) => (
                  <button key={x} onClick={() => ask(x)} className="rounded-full border border-line-strong px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2">{x}</button>
                ))}
              </div>
            </Card>
          )}

          {turns.map((t, i) => (
            <div key={i} className="space-y-2">
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[14px] text-white">{t.q}</div>
              <Card pad={false}>
                {t.status.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-b border-line px-5 py-2.5 text-[12px] text-ink-3">
                    {t.status.map((s, k) => <span key={k} className="rounded-md bg-surface-2 px-1.5 py-0.5">🔎 {s}</span>)}
                    {t.busy && <span className="animate-pulse">…</span>}
                  </div>
                )}
                <div className="px-5 py-4">
                  {t.error ? (
                    <p className="text-[13.5px] text-err">{t.error}</p>
                  ) : t.blocks ? (
                    <div className="answer rich text-[14px]" dangerouslySetInnerHTML={{ __html: renderAnswer(t.blocks, t.sources) }} />
                  ) : t.streaming ? (
                    <div className="answer rich text-[14px] opacity-90" dangerouslySetInnerHTML={{ __html: renderStreaming(t.streaming) }} />
                  ) : (
                    <p className="animate-pulse text-[13.5px] text-ink-3">FAQ 를 찾는 중입니다…</p>
                  )}
                </div>
                {t.sources.length > 0 && (
                  <div className="border-t border-line px-5 py-3">
                    <div className="mb-1.5 text-[12px] font-semibold text-ink-3">출처</div>
                    <ol className="space-y-1.5 text-[13px]">
                      {t.sources.map((s) => (
                        <li key={s.n}>
                          <span className="mr-1 font-semibold text-brand-ink">[{s.n}]</span>
                          <Link href={`/faq/${s.id}`} target="_blank" className="text-ink hover:text-brand-ink hover:underline">{s.title}</Link>
                          <span className="ml-1.5 inline-block align-middle"><DisclosureTag v={s.disclosure} /></span>
                          {s.disclosure === "internal" && <span className="ml-1 text-[11.5px] text-err">내부 자료 — 고객에게 그대로 전달하지 말 것</span>}
                          {s.quotes[0] && <div className="mt-0.5 line-clamp-2 border-l-2 border-line pl-2 text-[12px] text-ink-3">{s.quotes[0]}</div>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {!t.busy && t.qaId && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-2.5 text-[12.5px]">
                    {t.found === false && <span className="text-warn">FAQ 에 근거 문서가 없었습니다 — 관리자에게 보강 거리로 남습니다</span>}
                    <span className="ml-auto text-ink-3">답이 도움이 됐나요?</span>
                    {([1, -1] as const).map((r) => (
                      <button key={r} disabled={t.rated !== 0} onClick={() => rate(i, r)}
                              className={cx("rounded-lg border px-2 py-0.5", t.rated === r ? "border-brand bg-brand-soft" : "border-line-strong hover:bg-surface-2", t.rated !== 0 && t.rated !== r && "opacity-40")}>
                        {r === 1 ? "👍" : "👎"}
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          ))}
          <div ref={bottom} />

          <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="sticky bottom-3 flex gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[0_4px_16px_rgba(16,24,40,.08)]">
            <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={2} disabled={busy}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(q); } }}
                      placeholder={turns.length ? "이어서 물어보세요 (Enter 보내기 · Shift+Enter 줄바꿈)" : "증상 · 모델 · 하고 싶은 일을 적어 주세요"}
                      className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] outline-none" />
            <div className="flex flex-col gap-1">
              {busy
                ? <button type="button" onClick={() => abort.current?.abort()} className="rounded-xl border border-line-strong px-4 py-2 text-[13px]">멈춤</button>
                : <button type="submit" disabled={!q.trim()} className="rounded-xl bg-brand px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">보내기</button>}
              {turns.length > 0 && !busy && <button type="button" onClick={() => setTurns([])} className="text-[11.5px] text-ink-3 hover:text-ink">새 대화</button>}
            </div>
          </form>
        </div>

        <aside className="space-y-4">
          <Card title="내 최근 질문">
            {mine.data?.items.length ? (
              <ul className="space-y-1.5 text-[13px]">
                {mine.data.items.map((l) => (
                  <li key={l.id}>
                    <button onClick={() => ask(l.question)} disabled={busy} className="line-clamp-2 text-left text-ink hover:text-brand-ink">{l.question}</button>
                    <div className="text-[11px] text-ink-3">{kst(l.created_at)}{l.found === false ? " · 못 찾음" : ""}{l.rating === -1 ? " · 👎" : ""}</div>
                  </li>
                ))}
              </ul>
            ) : <Empty>아직 질문이 없습니다</Empty>}
          </Card>
          {mine.data?.admin && (
            <Card title="FAQ 보강 거리">
              <p className="mb-2 text-[12px] text-ink-3">FAQ 에서 못 찾았거나 👎 받은 질문 — 새 문서를 쓸 거리입니다.</p>
              {gaps.data?.items.length ? (
                <ul className="space-y-1.5 text-[13px]">
                  {gaps.data.items.map((l) => (
                    <li key={l.id}>
                      <div className="line-clamp-2">{l.question}</div>
                      <div className="text-[11px] text-ink-3">{l.username} · {kst(l.created_at)}{l.error ? " · 오류" : l.found === false ? " · 못 찾음" : " · 👎"}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[13px] text-ink-3">없습니다</p>}
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
