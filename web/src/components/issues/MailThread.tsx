"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { kst, type MailMessage } from "@/lib/issues";
import { cx } from "@/components/ui";

/** 메일 문서의 원문 스레드 — 펼칠 때 불러온다. 인용문 · 서명은 걷어낸 본문만 보인다. */
export function MailThread({ docId, count }: { docId: number; count: number }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<MailMessage[] | null>(null);
  const [err, setErr] = useState("");

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && msgs === null) {
      try {
        setMsgs((await api<{ messages: MailMessage[] }>(`/api/issues/sb/${docId}/thread`)).messages);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  }

  return (
    <div className="rounded-xl border border-line">
      <button type="button" onClick={toggle} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold hover:bg-surface-2">
        <span className={cx("inline-block transition-transform", open && "rotate-90")}>▸</span>
        원문 메일 {count}통
        <span className="font-normal text-ink-3">· 인용문과 서명은 뺐습니다</span>
      </button>
      {open && (
        <div className="max-h-[520px] divide-y divide-line overflow-auto border-t border-line">
          {err && <p className="px-4 py-3 text-[12.5px] text-err">{err}</p>}
          {!err && msgs === null && <p className="px-4 py-3 text-[12.5px] text-ink-3">불러오는 중…</p>}
          {msgs?.map((m) => {
            const ours = /@pointmobile\.com$/i.test(m.from);
            return (
              <div key={m.id} className={cx("px-4 py-3", ours && "bg-brand-soft/30")}>
                <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
                  <span className={cx("font-semibold", ours ? "text-brand-ink" : "text-ink")}>{m.name || m.from}</span>
                  <span className="text-ink-3">{m.from}</span>
                  <span className="ml-auto text-ink-3">{kst(m.at)}</span>
                </div>
                {m.attachments.length > 0 && <div className="mt-1 text-[11.5px] text-ink-3">첨부 · {m.attachments.join(", ")}</div>}
                <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{m.body || "(본문 없음)"}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
