"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { DISCLOSURE_TONE, kst, SB_STATE_TONE, type SbDoc, type SbList } from "@/lib/issues";
import { cx } from "@/components/ui";
import { Btn, Modal, useToast } from "./kit";
import { RichEditor } from "./RichEditor";
import { MailThread } from "./MailThread";
import { SbAssist } from "./SbAssist";

type Form = { title: string; disclosure: string; applies_to: string; description_html: string; partners: string[] };

function formOf(d: SbDoc): Form {
  return { title: d.title, disclosure: d.disclosure, applies_to: d.applies_to, description_html: d.description_html,
           partners: [...d.partners] };
}

export function SbStateChip({ d }: { d: Pick<SbDoc, "state" | "state_label"> }) {
  return <span className={cx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold", SB_STATE_TONE[d.state] ?? "bg-muted-soft text-ink-2")}>{d.state_label}</span>;
}

export function DisclosureTag({ v }: { v: string }) {
  return <span className={cx("inline-flex rounded-md border px-1.5 py-[1px] text-[11px] font-semibold", DISCLOSURE_TONE[v] ?? "border-line text-ink-2")}>{v}</span>;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-ink-3">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

const input = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[14px] outline-none focus:border-brand";

/** SB 문서 한 건 — 상태에 맞는 화면(생성 대기 · 실패 · 편집 · 확정 · 폐기). */
export function SbDocPanel({ doc, meta, onChanged }: { doc: SbDoc; meta: SbList; onChanged: (d?: SbDoc) => void }) {
  const toast = useToast();
  const [form, setForm] = useState<Form>(formOf(doc));
  const [busy, setBusy] = useState<string>("");
  const [askApprove, setAskApprove] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [discardReason, setDiscardReason] = useState("");

  useEffect(() => {
    setForm(formOf(doc));
  }, [doc.id, doc.state, doc.generated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(formOf(doc)), [form, doc]);
  const editable = ["draft", "notified"].includes(doc.state);

  async function call<T>(name: string, path: string, body?: unknown): Promise<T | null> {
    setBusy(name);
    try {
      return await api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "err");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function save() {
    const r = await call<{ message: string; doc: SbDoc }>("save", `/api/issues/sb/${doc.id}/save`, form);
    if (r) { toast(r.message); onChanged(r.doc); }
  }
  async function notify() {
    const r = await call<{ message: string }>("notify", `/api/issues/sb/${doc.id}/notify`, form);
    if (r) { toast(r.message); onChanged(); }
  }
  async function approve() {
    setAskApprove(false);
    const r = await call<{ message: string }>("approve", `/api/issues/sb/${doc.id}/approve`, form);
    if (r) { toast(r.message); onChanged(); }
  }
  async function generate() {
    const r = await call<{ message: string }>("generate", `/api/issues/sb/${doc.id}/generate`);
    if (r) { toast(r.message, "info"); onChanged(); }
  }

  // 생성은 서버 스레드에서 돈다 — 끝날 때까지 3초마다 문서를 다시 읽는다.
  useEffect(() => {
    if (!doc.generating) return;
    const t = setInterval(async () => {
      try {
        const d = await api<SbDoc>(`/api/issues/sb/${doc.id}`);
        if (!d.generating) {
          clearInterval(t);
          if (d.gen_result && !d.gen_result.ok) toast(`생성 실패: ${d.gen_result.error ?? ""}`, "err");
          else toast(`초안 생성 완료 — ${(d.title || "").slice(0, 50)}`);
          onChanged(d);
        }
      } catch { /* 다음 주기에 다시 */ }
    }, 3000);
    return () => clearInterval(t);
  }, [doc.generating, doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function discard() {
    setAskDiscard(false);
    const r = await call<{ message: string }>("discard", `/api/issues/sb/${doc.id}/discard`, { reason: discardReason });
    if (r) { toast(r.message, "info"); setDiscardReason(""); onChanged(); }
  }
  async function reopen() {
    const r = await call<{ message: string }>("reopen", `/api/issues/sb/${doc.id}/reopen`);
    if (r) { toast(r.message, "info"); onChanged(); }
  }

  function togglePartner(key: string) {
    setForm((f) => ({ ...f, partners: f.partners.includes(key) ? f.partners.filter((x) => x !== key) : [...f.partners, key] }));
  }

  const isMail = doc.source === "mail";
  const times = [
    [isMail ? "마지막 메일" : "해결", doc.resolved_at], ["생성", doc.generated_at], ["검토 요청", doc.notified_at], ["확정", doc.state === "approved" ? doc.decided_at : ""],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="flex h-full flex-col">
      {/* 머리 */}
      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <SbStateChip d={doc} />
          {!["backlog", "queued"].includes(doc.state) && <DisclosureTag v={doc.disclosure} />}
          {doc.revision > 1 && <span className="rounded-md border border-warn/40 px-1.5 py-[1px] text-[11px] font-semibold text-warn" title="이슈가 다시 열렸다가 해결되어 새로 작성된 문서">{doc.revision}판</span>}
          {isMail
            ? <span className="ml-1 text-[12.5px] font-semibold text-ink-2">메일 {doc.mail_count}통</span>
            : <a href={doc.issue_url} target="_blank" rel="noreferrer" className="ml-1 text-[12.5px] font-semibold text-brand-ink hover:underline">#{doc.issue_id} ↗</a>}
          <span className="ml-auto text-[12px] text-ink-3">{doc.assignee || "담당자 없음"}</span>
        </div>
        <div className="mt-1.5 text-[16px] font-bold leading-snug">{doc.title || doc.subject}</div>
        <div className="mt-1 text-[12.5px] text-ink-3">
          {isMail ? `✉ ${doc.subject}` : `[${doc.issue_status}] ${doc.subject}`}
        </div>
        {isMail && doc.mail_new > 0 && (
          <div className="mt-2 rounded-lg bg-warn-soft px-3 py-1.5 text-[12.5px] text-warn">초안을 만든 뒤 새 메일 {doc.mail_new}통이 더 왔습니다 — 원문을 확인해 반영하세요</div>
        )}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
          {times.map(([k, v]) => <span key={k}>{k} {kst(v)}</span>)}
          {doc.in_tok > 0 && <span>토큰 {doc.in_tok.toLocaleString()}/{doc.out_tok.toLocaleString()}</span>}
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
        {isMail && <MailThread key={doc.id} docId={doc.id} count={doc.mail_count} editable={editable} />}
        {["backlog", "queued"].includes(doc.state) && (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <div className="text-[14px] font-semibold">초안 미생성</div>
            <div className="mt-1 text-[12.5px] text-ink-3">5분 주기 작업이 차례대로 만든다 · Claude 로 30초 안팎</div>
            <Btn kind="primary" className="mt-3" busy={busy === "generate" || doc.generating} onClick={generate}>{doc.generating ? "Claude 가 작성 중" : "지금 초안 생성"}</Btn>
          </div>
        )}

        {doc.state === "error" && (
          <div className="rounded-xl bg-err-soft px-4 py-3">
            <div className="text-[13px] font-semibold text-err">생성 실패</div>
            <div className="mt-1 whitespace-pre-wrap break-all text-[12.5px] text-err">{doc.error || "알 수 없는 오류"}</div>
            <Btn kind="primary" className="mt-3" busy={busy === "generate" || doc.generating} onClick={generate}>{doc.generating ? "Claude 가 작성 중" : "다시 생성"}</Btn>
          </div>
        )}

        {doc.state === "approved" && (
          <div className="rounded-xl bg-ok-soft px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ok">
              확정됨
              <DisclosureTag v={doc.disclosure} />
              {doc.decided_by && <span className="font-normal">· {doc.decided_by}</span>}
            </div>
            {doc.applies_to && <div className="mt-2 text-[12.5px] text-ink-2">Applies to: {doc.applies_to}</div>}
            <Btn className="mt-3" busy={busy === "reopen"} onClick={reopen}>확정 취소 (초안으로)</Btn>
          </div>
        )}
        {doc.state === "approved" && doc.description_html && (
          <div className="rich rounded-xl border border-line px-4 py-3" dangerouslySetInnerHTML={{ __html: doc.description_html }} />
        )}

        {doc.state === "discarded" && (
          <div className="rounded-xl bg-muted-soft px-4 py-3">
            <div className="text-[13px] font-semibold">폐기됨{doc.decided_by ? ` · ${doc.decided_by}` : ""}</div>
            {doc.error && <div className="mt-1 text-[12.5px] text-ink-2">{doc.error}</div>}
            <Btn className="mt-3" busy={busy === "reopen"} onClick={reopen}>되돌리기</Btn>
          </div>
        )}

        {["not_needed", "not_target"].includes(doc.state) && (
          <div className="rounded-xl bg-muted-soft px-4 py-3 text-[13px] text-ink-2">{doc.state_label} — 문서를 만들지 않는 건</div>
        )}

        {editable && (
          <>
            {doc.reason && (
              <div className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[12.5px] text-ink-2">
                <span className="font-semibold text-ink">Claude 판단 근거</span> · {doc.reason}
              </div>
            )}
            <Field label="제목" hint="Troubleshooting 문서는 '[TR] ' 로 시작">
              <input className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="공개 등급">
              <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
                {Object.entries(meta.disclosures).map(([k, ko]) => (
                  <button key={k} type="button" onClick={() => setForm({ ...form, disclosure: k })}
                          className={cx("rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                            form.disclosure === k ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong hover:bg-surface-2")}>
                    <span className="font-semibold">{k}</span> <span className="text-ink-3">{ko}</span>
                  </button>
                ))}
              </div>
            </Field>
            {form.disclosure === "partner" && (
              <Field label="공개 파트너">
                <div className="flex flex-wrap gap-3">
                  {Object.entries(meta.partners).map(([k, label]) => (
                    <label key={k} className="inline-flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={form.partners.includes(k)} onChange={() => togglePartner(k)} />
                      {label}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Applies to">
              <input className={input} value={form.applies_to} onChange={(e) => setForm({ ...form, applies_to: e.target.value })} />
            </Field>
            <div>
              <span className="mb-1 block text-[12px] font-semibold text-ink-3">Description</span>
              <RichEditor value={form.description_html} onChange={(h) => setForm((f) => ({ ...f, description_html: h }))}
                          placeholder="배경 → 증상 → 원인 → 해결 순서로 작성" />
            </div>
            <SbAssist key={doc.id} docId={doc.id} form={form}
                      onApply={(d) => setForm((f) => ({ ...f, ...d }))} />

          </>
        )}
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3">
          <Btn onClick={save} busy={busy === "save"} disabled={!!busy && busy !== "save"}>{dirty ? "저장 •" : "저장"}</Btn>
          {doc.state === "draft" && (
            <Btn kind="soft" onClick={notify} busy={busy === "notify"} disabled={!!busy && busy !== "notify"}
                 title={`수신: ${doc.email || "담당자 주소를 못 만들어 관리자에게"}`}>검토 요청 메일</Btn>
          )}
          <Btn kind="primary" onClick={() => setAskApprove(true)} busy={busy === "approve"} disabled={!!busy && busy !== "approve"}>확정</Btn>
          <span className="flex-1" />
          <Btn kind="danger" onClick={() => setAskDiscard(true)} disabled={!!busy}>폐기</Btn>
        </div>
      )}

      <Modal open={askApprove} onClose={() => setAskApprove(false)} title="이 문서를 확정"
             actions={<><Btn onClick={() => setAskApprove(false)}>취소</Btn><Btn kind="primary" onClick={approve}>확정</Btn></>}>
        <dl className="grid grid-cols-[80px_1fr] gap-y-1.5 text-[13.5px]">
          <dt className="text-ink-3">제목</dt><dd className="break-all font-semibold">{form.title}</dd>
          <dt className="text-ink-3">공개 등급</dt><dd><DisclosureTag v={form.disclosure} /> {meta.disclosures[form.disclosure]}</dd>
        </dl>
        <p className="mt-3 text-[12.5px] text-ink-3">저장한 뒤 확정한다. 확정한 문서는 고칠 수 없고, 확정을 취소하면 다시 초안이 된다.</p>
      </Modal>

      <Modal open={askDiscard} onClose={() => setAskDiscard(false)} title="이 초안을 폐기"
             actions={<><Btn onClick={() => setAskDiscard(false)}>취소</Btn><Btn kind="danger" onClick={discard}>폐기</Btn></>}>
        <p className="mb-2 text-[13px] text-ink-2">초안은 이력으로 남고, 언제든 되돌릴 수 있다.</p>
        <input className={input} placeholder="사유 (선택)" value={discardReason} onChange={(e) => setDiscardReason(e.target.value)} />
      </Modal>
    </div>
  );
}
