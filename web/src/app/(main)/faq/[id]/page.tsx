"use client";

import Link from "next/link";
import { use, useState } from "react";
import { api, useApi } from "@/lib/api";
import { kst, type FaqDetail } from "@/lib/issues";
import { Card, cx, Empty, Skeleton } from "@/components/ui";
import { DisclosureTag } from "@/components/issues/SbDocPanel";
import { RichStyle } from "@/components/issues/RichEditor";

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n > 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);

/** FAQ 문서 하나 — 본문 · 첨부 · 원본 링크 · 관련 문서 · '도움이 됐나요'. */
export default function FaqArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const res = useApi<FaqDetail>(`/api/faq/${id}`);
  const [voted, setVoted] = useState("");
  const d = res.data;

  if (res.error) return <Card><Empty>{res.error} · <Link href="/faq" className="text-brand-ink underline">FAQ 로</Link></Empty></Card>;
  if (!d) return <Skeleton rows={8} />;
  const a = d.article;
  const files = d.attachments.filter((f) => !f.is_image);

  async function vote(up: boolean) {
    const r = await api<{ message: string }>(`/api/faq/${id}/vote`, { method: "POST", body: JSON.stringify({ up }) }).catch(() => null);
    if (r) setVoted(up ? "up" : "down");
  }

  return (
    <>
      <RichStyle />
      <div className="mb-3 text-[13px]">
        <button onClick={() => history.length > 1 ? history.back() : (location.href = "/faq")} className="text-brand-ink hover:underline">← FAQ</button>
        {a.category && <span className="ml-2 text-ink-3">{a.category}</span>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card pad={false}>
          <div className="border-b border-line px-6 py-5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11.5px] font-semibold text-brand-ink">{d.labels.kind[a.kind] ?? a.kind}</span>
              <DisclosureTag v={a.disclosure} />
              <span className="text-[12px] text-ink-3">{d.labels.disclosure[a.disclosure]}</span>
              {a.products.map((p) => (
                <Link key={p} href={`/faq?product=${encodeURIComponent(p)}`} className="rounded-md border border-line px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-2">{p}</Link>
              ))}
            </div>
            <h1 className="mt-2 text-[21px] font-bold leading-snug tracking-tight">{a.title}</h1>
            {a.applies_to && <div className="mt-1.5 text-[13px] text-ink-2"><b className="text-ink">Applies to</b> · {a.applies_to}</div>}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
              {a.author && <span>작성 {a.author}</span>}
              {a.approved_by && <span>확정 {a.approved_by}</span>}
              <span>수정 {kst(a.updated_at).slice(0, 10)}</span>
              <span>조회 {a.view_count.toLocaleString()}</span>
            </div>
          </div>
          {a.summary && (
            <div className="mx-6 mt-4 rounded-lg bg-surface-2 px-4 py-2.5 text-[13px] text-ink-2"><b className="text-ink">요약</b> · {a.summary}</div>
          )}
          <div className="rich px-6 py-5 text-[14px]" dangerouslySetInnerHTML={{ __html: a.body_html || "<p>(본문 없음)</p>" }} />

          <div className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-3.5 text-[13px]">
            <span className="text-ink-2">이 문서가 도움이 됐나요?</span>
            {(["up", "down"] as const).map((k) => (
              <button key={k} disabled={!!voted} onClick={() => vote(k === "up")}
                      className={cx("rounded-lg border px-2.5 py-1", voted === k ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong hover:bg-surface-2", voted && voted !== k && "opacity-40")}>
                {k === "up" ? "👍 네" : "👎 아니요"}
              </button>
            ))}
            {voted && <span className="text-ink-3">고맙습니다</span>}
          </div>
        </Card>

        <aside className="space-y-4">
          <Card title="원본">
            <div className="space-y-1.5 text-[13px]">
              {d.issues.map((i) => (
                <a key={i.id} href={i.url} target="_blank" rel="noreferrer" className="block text-brand-ink hover:underline">Redmine #{i.id} ↗</a>
              ))}
              {a.source === "confluence" && a.source_url && (
                <a href={a.source_url} target="_blank" rel="noreferrer" className="block text-brand-ink hover:underline">
                  Confluence · {d.labels.space[a.source_space ?? ""] ?? a.source_space} ↗
                </a>
              )}
              {a.source === "sb" && <span className="block text-ink-2">업로드에서 확정</span>}
              {a.source === "mail" && <span className="block text-ink-2">메일 문의 · 업로드에서 확정</span>}
              {a.labels.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {a.labels.map((l) => <span key={l} className="rounded-md bg-muted-soft px-1.5 text-[11px] text-ink-2">{l}</span>)}
                </div>
              )}
            </div>
          </Card>
          {files.length > 0 && (
            <Card title={`첨부 ${files.length}`}>
              <ul className="space-y-1.5 text-[13px]">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <a href={`/api/kb/files/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-brand-ink hover:underline" title={f.filename}>📎 {f.filename}</a>
                    <span className="shrink-0 text-[11.5px] text-ink-3">{size(f.size)}{!f.stored && " · 원본"}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="관련 문서">
            {d.related.length ? (
              <ul className="space-y-2 text-[13px]">
                {d.related.map((r) => (
                  <li key={r.id}>
                    <Link href={`/faq/${r.id}`} className="leading-snug text-ink hover:text-brand-ink hover:underline">{r.title}</Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                      <span>{d.labels.kind[r.kind] ?? r.kind}</span><DisclosureTag v={r.disclosure} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-3">같은 모델 · 라벨의 문서가 없습니다</p>}
          </Card>
        </aside>
      </div>
    </>
  );
}
