"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { cx } from "@/components/ui";
import { Btn } from "./kit";

type Draft = { title: string; disclosure: string; applies_to: string; description_html: string };
type Result = {
  proposal: Draft; disclosure_reason: string; changes: string; reply: string;
};
type Turn = { instruction: string; busy: boolean; error: string; result: Result | null; state: "pending" | "applied" | "discarded" };

const QUICK = [
  "더 간결하게 줄여줘",
  "해결 단계를 번호 목록으로 정리해줘",
  "고객에게 보여줄 수 있게 표현을 다듬어줘",
  "영어로 바꿔줘",
  "공개 등급이 맞는지 다시 판단해줘",
];

const FIELD_NAME: Record<keyof Draft, string> = { title: "제목", disclosure: "공개 등급", applies_to: "Applies to", description_html: "본문" };

/**
 * Claude 와 초안 고치기 — 지시하면 Claude 가 이슈 원문과 지금 초안(저장 전 내용 포함)을 보고 수정안을 낸다.
 * 수정안은 바로 덮어쓰지 않는다. [적용]을 눌러야 편집 칸에 들어가고, 저장 · 확정은 평소대로.
 */
export function SbAssist({ docId, form, onApply }: { docId: number; form: Draft; onApply: (d: Draft) => void }) {
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const busy = turns.some((t) => t.busy);

  async function ask(instruction: string) {
    const ins = instruction.trim();
    if (!ins || busy) return;
    setText("");
    const i = turns.length;
    const history = turns.filter((t) => t.result).map((t) => ({
      instruction: t.instruction,
      changes: `${t.result!.changes}${t.state === "applied" ? " (적용함)" : t.state === "discarded" ? " (버림)" : ""}`,
    }));
    setTurns((ts) => [...ts, { instruction: ins, busy: true, error: "", result: null, state: "pending" }]);
    try {
      const r = await api<Result>(`/api/issues/sb/${docId}/assist`, {
        method: "POST",
        body: JSON.stringify({ instruction: ins, form: { title: form.title, disclosure: form.disclosure, applies_to: form.applies_to, description_html: form.description_html }, history }),
      });
      setTurns((ts) => ts.map((t, k) => (k === i ? { ...t, busy: false, result: r } : t)));
      setOpen(i);
    } catch (e) {
      setTurns((ts) => ts.map((t, k) => (k === i ? { ...t, busy: false, error: e instanceof Error ? e.message : String(e) } : t)));
    }
  }

  function decide(i: number, apply: boolean) {
    const t = turns[i];
    if (apply && t.result) onApply(t.result.proposal);
    setTurns((ts) => ts.map((x, k) => (k === i ? { ...x, state: apply ? "applied" : "discarded" } : x)));
    setOpen(null);
  }

  const changed = (p: Draft) => (Object.keys(FIELD_NAME) as (keyof Draft)[]).filter((k) => (p[k] ?? "").trim() !== (form[k] ?? "").trim());

  return (
    <div className="rounded-xl border border-brand/30 bg-brand-soft/40">
      <div className="flex items-center gap-2 border-b border-brand/20 px-4 py-2.5">
        <span className="text-[13px] font-semibold text-brand-ink">✨ Claude 와 고치기</span>
        <span className="text-[11.5px] text-ink-3">이슈 원문과 지금 초안을 보고 고친다 · [적용]해야 편집 칸에 들어간다</span>
      </div>

      {turns.length > 0 && (
        <div className="divide-y divide-line/70">
          {turns.map((t, i) => (
            <div key={i} className="px-4 py-2.5 text-[13px]">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-brand px-1.5 text-[11px] font-semibold text-white">지시</span>
                <span className="flex-1">{t.instruction}</span>
                {t.state === "applied" && <span className="shrink-0 text-[11.5px] font-semibold text-ok">적용함</span>}
                {t.state === "discarded" && <span className="shrink-0 text-[11.5px] text-ink-3">버림</span>}
              </div>
              {t.busy && <p className="mt-1.5 animate-pulse text-[12.5px] text-ink-3">Claude 가 고치는 중… (보통 20~40초)</p>}
              {t.error && <p className="mt-1.5 text-[12.5px] text-err">{t.error}</p>}
              {t.result && (
                <div className="mt-1.5 space-y-1.5">
                  {t.result.reply && <p className="whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 text-ink-2">{t.result.reply}</p>}
                  <p className="text-ink-2"><b className="text-ink">바꾼 것</b> · {t.result.changes}</p>
                  {t.state === "pending" && (() => {
                    const ch = changed(t.result.proposal);
                    return (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {ch.length ? ch.map((k) => <span key={k} className="rounded-md border border-brand/40 px-1.5 text-[11.5px] text-brand-ink">{FIELD_NAME[k]} 바뀜</span>)
                                     : <span className="text-[12px] text-ink-3">지금 초안과 같습니다</span>}
                          {ch.includes("disclosure") && <span className="text-[11.5px] text-ink-3">→ {t.result.proposal.disclosure} · {t.result.disclosure_reason}</span>}
                          <button onClick={() => setOpen(open === i ? null : i)} className="ml-auto text-[12px] text-brand-ink hover:underline">
                            {open === i ? "미리보기 닫기" : "미리보기"}
                          </button>
                        </div>
                        {open === i && (
                          <div className="rounded-lg border border-line bg-surface px-3 py-2">
                            {ch.includes("title") && <div className="mb-1 text-[13.5px] font-semibold">{t.result.proposal.title}</div>}
                            {ch.includes("applies_to") && <div className="mb-1 text-[12.5px] text-ink-2">Applies to · {t.result.proposal.applies_to}</div>}
                            <div className="rich max-h-[360px] overflow-auto text-[13px]" dangerouslySetInnerHTML={{ __html: t.result.proposal.description_html }} />
                          </div>
                        )}
                        {ch.length > 0 && (
                          <div className="flex gap-2">
                            <Btn kind="primary" onClick={() => decide(i, true)}>적용</Btn>
                            <Btn onClick={() => decide(i, false)}>버리기</Btn>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-brand/20 px-4 py-2.5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK.map((qk) => (
            <button key={qk} type="button" disabled={busy} onClick={() => ask(qk)}
                    className={cx("rounded-full border border-line-strong bg-surface px-2.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2", busy && "opacity-50")}>
              {qk}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); ask(text); }} className="flex gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={busy}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(text); } }}
                    placeholder="무엇을 고칠지 적어 주세요 — 예) 원인 설명을 한 문단으로, 해결 방법에 확인 순서를 추가 (Enter 보내기)"
                    className="min-w-0 flex-1 resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-brand" />
          <Btn kind="primary" type="submit" busy={busy} disabled={!text.trim() || busy}>보내기</Btn>
        </form>
      </div>
    </div>
  );
}
