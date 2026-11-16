"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { missingIn, type Specific } from "@/server/issuetrack/specifics";

/**
 * 원문 대조 — 원문에 있는 히든 메뉴 진입 · 다이얼 코드 · 메뉴 경로 · 명령 · 버전 중 지금 초안(편집 중인 내용)에 없는 것.
 * 규칙으로 뽑으므로 관련 없는 것도 섞일 수 있다 — 필요한 것만 넣으면 된다.
 */
export function MissingSpecifics({ docId, html, onAsk }: { docId: number; html: string; onAsk?: (text: string) => void }) {
  const [items, setItems] = useState<Specific[] | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    api<{ items: Specific[] }>(`/api/issues/sb/${docId}/specifics`).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [docId]);
  const lost = useMemo(() => (items ? missingIn(html, items) : []), [items, html]);
  if (!lost.length) return null;
  return (
    <div className="rounded-xl border border-warn/40 bg-warn-soft/50 px-4 py-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-[13px] font-semibold text-warn">
        원문에 있는데 초안에 없는 것 {lost.length}개
        <span className="font-normal text-ink-3">· 히든 메뉴 · 코드 · 경로 · 명령 · 버전 — 필요한 것은 본문에 넣으세요</span>
        <span className="ml-auto text-[12px] font-normal">{open ? "접기" : "펼치기"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1">
          {lost.map((x, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px]">
              <span className="shrink-0 rounded bg-surface px-1.5 text-[11px] text-ink-3">{x.kind}</span>
              <code className="min-w-0 flex-1 break-all text-ink">{x.text}</code>
            </li>
          ))}
        </ul>
      )}
      {open && onAsk && (
        <button type="button" onClick={() => onAsk(`원문에 있는데 초안에 빠진 다음 내용 중 이 문서와 관련된 것을 원문 그대로 알맞은 자리에 넣어줘:\n${lost.map((x) => `- ${x.text}`).join("\n")}`)}
                className="mt-2 text-[12px] font-semibold text-brand-ink hover:underline">
          Claude 와 고치기에 이 목록으로 요청 넣기 ↓
        </button>
      )}
    </div>
  );
}
