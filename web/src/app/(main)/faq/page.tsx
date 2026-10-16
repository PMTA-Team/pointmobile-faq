"use client";

import { useState } from "react";
import { useApi } from "@/lib/api";
import { kst, type FaqItem, type FaqList } from "@/lib/issues";
import { Card, cx, Empty, PageHead, Skeleton } from "@/components/ui";
import { FilterChip, SearchBox, useDebounced } from "@/components/issues/kit";
import { DisclosureTag } from "@/components/issues/SbDocPanel";
import { RichStyle } from "@/components/issues/RichEditor";

const PAGE = 50;

/** FAQ — 담당자가 확정한 SB 문서를 질문 목록처럼 읽는다. 제목을 누르면 본문이 펼쳐진다. */
export default function FaqPage() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [disclosure, setDisclosure] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);

  const qs = new URLSearchParams({ q: dq, disclosure, limit: String(limit) }).toString();
  const list = useApi<FaqList>(`/api/faq?${qs}`);
  const data = list.data;
  const all = data ? Object.values(data.counts).reduce((a, n) => a + n, 0) : 0;

  return (
    <>
      <RichStyle />
      <PageHead title="FAQ" lead="담당자가 검토하고 확정한 Solution Buffer 문서. 제목을 누르면 내용이 펼쳐집니다." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={(v) => { setQ(v); setLimit(PAGE); setOpen(null); }} placeholder="제목 · 모델 · 내용 · #이슈번호" />
        <span className="ml-auto text-[12px] text-ink-3">{data ? `${data.total.toLocaleString()}건` : ""}</span>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip active={!disclosure} onClick={() => { setDisclosure(""); setLimit(PAGE); }}>전체 {all || ""}</FilterChip>
        {data && Object.entries(data.disclosures).map(([k, ko]) => (
          <FilterChip key={k} active={disclosure === k} onClick={() => { setDisclosure(k); setLimit(PAGE); }}>
            {ko} {data.counts[k] ?? 0}
          </FilterChip>
        ))}
      </div>

      <Card pad={false}>
        {list.loading && !data ? <Skeleton rows={6} /> : data?.items.length ? (
          <div>
            {data.items.map((f) => (
              <FaqRow key={f.id} f={f} partners={data.partners} open={open === f.id}
                      onToggle={() => setOpen((o) => (o === f.id ? null : f.id))} />
            ))}
            {data.items.length < data.total && (
              <button onClick={() => setLimit((l) => l + PAGE)}
                      className="block w-full px-5 py-3 text-center text-[13px] font-semibold text-brand-ink hover:bg-surface-2">
                더 보기 (남은 {(data.total - data.items.length).toLocaleString()}건)
              </button>
            )}
          </div>
        ) : (
          <Empty>{dq || disclosure ? "조건에 맞는 FAQ 가 없습니다" : "아직 확정된 문서가 없습니다 — [업로드 → SB 문서]에서 확정하면 여기에 모입니다"}</Empty>
        )}
      </Card>
      {list.error && <p className="mt-3 text-[13px] text-err">{list.error}</p>}
    </>
  );
}

function FaqRow({ f, partners, open, onToggle }: {
  f: FaqItem; partners: Record<string, string>; open: boolean; onToggle: () => void;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      <button onClick={onToggle} aria-expanded={open}
              className={cx("flex w-full items-start gap-3 px-5 py-3.5 text-left", open ? "bg-surface-2" : "hover:bg-surface-2")}>
        <span className={cx("mt-0.5 text-[13px] text-ink-3 transition-transform", open && "rotate-90")} aria-hidden>▶</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold leading-snug">{f.title || `#${f.issue_id}`}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
            <DisclosureTag v={f.disclosure} />
            {f.applies_to && <span className="truncate">{f.applies_to}</span>}
          </span>
        </span>
        {f.decided_at && <span className="shrink-0 text-[11.5px] text-ink-3">{kst(f.decided_at).slice(0, 10)}</span>}
      </button>
      {open && (
        <div className="px-5 pb-5 pl-11">
          {f.applies_to && <div className="mb-2 text-[13px] text-ink-2"><b className="text-ink">Applies to</b> · {f.applies_to}</div>}
          {f.disclosure === "partner" && f.partners.length > 0 && (
            <div className="mb-2 text-[12.5px] text-ink-3">공개 파트너 · {f.partners.map((p) => partners[p] ?? p).join(", ")}</div>
          )}
          {f.description_html
            ? <div className="rich rounded-xl border border-line px-4 py-3" dangerouslySetInnerHTML={{ __html: f.description_html }} />
            : <p className="text-[13px] text-ink-3">본문이 없습니다</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
            <a href={f.issue_url} target="_blank" rel="noreferrer" className="font-semibold text-brand-ink hover:underline">Redmine #{f.issue_id} ↗</a>
            {f.revision > 1 && <span>{f.revision}판</span>}
            {f.decided_by && <span>확정 {f.decided_by}{f.decided_at ? ` · ${kst(f.decided_at)}` : ""}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
