"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { kst, type MailFile, type MailMessage } from "@/lib/issues";
import { cx } from "@/components/ui";
import { useToast } from "./kit";

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/**
 * 메일 문서의 원문 — 첨부 파일 목록(늘 보임)과 원문 메일(펼쳐 봄).
 * 첨부는 Dropbox 에 올린 것만 내려받을 수 있다. 'FAQ 에 함께 올리기'를 켠 파일만 확정 때 FAQ 첨부가 된다.
 */
export function MailThread({ docId, count, editable }: { docId: number; count: number; editable: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<MailMessage[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api<{ messages: MailMessage[] }>(`/api/issues/sb/${docId}/thread`)
      .then((r) => setMsgs(r.messages))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [docId]);

  async function toggle(f: MailFile) {
    try {
      await api(`/api/issues/sb/${docId}/files`, { method: "POST", body: JSON.stringify({ file_id: f.id, publish: !f.publish }) });
      setMsgs((ms) => ms?.map((m) => ({ ...m, files: m.files.map((x) => (x.id === f.id ? { ...x, publish: !f.publish } : x)) })) ?? ms);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
    }
  }

  const files = msgs?.flatMap((m) => m.files) ?? [];

  const fileRow = (f: MailFile) => (
    <div key={f.id} className="flex items-center gap-2 text-[12.5px]">
      {f.ready ? (
        <a href={`/api/mail/files/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-brand-ink hover:underline" title={f.filename}>📎 {f.filename}</a>
      ) : (
        <span className="min-w-0 flex-1 truncate text-ink-3" title={f.error || "다음 주기에 Dropbox 로 올린다"}>📎 {f.filename}</span>
      )}
      <span className="shrink-0 text-ink-3">{kb(f.size)}</span>
      {!f.ready && <span className="shrink-0 text-[11.5px] text-ink-3">{f.error ? "받지 못함" : "올리는 중"}</span>}
      {f.ready && editable && (
        <label className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-2">
          <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--brand)]" checked={f.publish} onChange={() => toggle(f)} />
          FAQ 에 함께
        </label>
      )}
      {f.ready && !editable && f.publish && <span className="shrink-0 text-[11.5px] text-ok">FAQ 첨부</span>}
    </div>
  );

  return (
    <div className="space-y-3">
      {files.length > 0 && (
        <div className="rounded-xl border border-line px-4 py-3">
          <div className="mb-1.5 text-[12px] font-semibold text-ink-3">
            첨부 파일 {files.length}개{editable && " · 'FAQ 에 함께'를 켠 파일만 확정할 때 FAQ 에 첨부됩니다(로그 · 엑셀은 고객 정보를 확인하세요)"}
          </div>
          <div className="space-y-1">{files.map(fileRow)}</div>
        </div>
      )}
      <div className="rounded-xl border border-line">
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-semibold hover:bg-surface-2">
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
                  {m.files.length > 0 && <div className="mt-1.5 space-y-0.5">{m.files.map(fileRow)}</div>}
                  <div className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{m.body || "(본문 없음)"}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
