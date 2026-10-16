"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "@/lib/api";
import { kst, type FaqHit, type FaqSearch } from "@/lib/issues";
import { Card, cx, Empty, PageHead, Skeleton } from "@/components/ui";
import { useDebounced } from "@/components/issues/kit";
import { DisclosureTag } from "@/components/issues/SbDocPanel";
import { RichStyle } from "@/components/issues/RichEditor";

const PAGE = 20;
const FILTERS = ["kind", "space", "product", "disclosure"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_TITLE: Record<Filter, string> = { kind: "종류", space: "출처", product: "모델", disclosure: "공개 등급" };

export default function FaqPage() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <FaqSearchPage />
    </Suspense>
  );
}

/**
 * FAQ — 처리한 이슈의 기록(해결 사례)과 Confluence 에서 옮긴 How-to · Troubleshooting 문서를 한곳에서 찾는다.
 * 검색 조건은 주소에 남겨, 링크를 그대로 남에게 줄 수 있다.
 */
function FaqSearchPage() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const dq = useDebounced(q, 350);
  const [limit, setLimit] = useState(PAGE);
  const filters = Object.fromEntries(FILTERS.map((f) => [f, sp.get(f) ?? ""])) as Record<Filter, string>;
  const sort = sp.get("sort") === "recent" ? "recent" : "relevance";

  // 검색어 · 걸러 보기 → 주소
  function push(next: Partial<Record<Filter | "q" | "sort", string>>) {
    const u = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) u.set(k, v);
      else u.delete(k);
    }
    setLimit(PAGE);
    router.replace(`${path}${u.toString() ? `?${u}` : ""}`, { scroll: false });
  }
  useEffect(() => {
    if ((sp.get("q") ?? "") !== dq) push({ q: dq });
  }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps

  const qs = new URLSearchParams({ q: sp.get("q") ?? "", sort, limit: String(limit) });
  for (const f of FILTERS) if (filters[f]) qs.set(f, filters[f]);
  const res = useApi<FaqSearch>(`/api/faq?${qs}`);
  const data = res.data;
  const active = FILTERS.filter((f) => filters[f]);

  return (
    <>
      <RichStyle />
      <PageHead title="FAQ" lead="처리한 이슈의 기록과 How-to · Troubleshooting 문서. 다음 이슈를 처리할 때 비슷한 사례를 찾아 읽는다." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <svg viewBox="0 0 24 24" className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-3" fill="none" stroke="currentColor" strokeWidth={1.9}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
                 placeholder="증상 · 모델 · 기능 · #이슈번호   예) PM85 스캐너 안 읽힘, factory reset FRP, #32713"
                 className="w-full rounded-xl border border-line-strong bg-surface py-3 pl-11 pr-10 text-[15px] outline-none focus:border-brand" />
          {q && <button onClick={() => setQ("")} className="absolute right-3 top-1/2 -translate-y-1/2 rounded px-1.5 text-ink-3 hover:text-ink" aria-label="지우기">×</button>}
        </div>
        <div className="flex overflow-hidden rounded-lg border border-line-strong text-[13px]">
          {(["relevance", "recent"] as const).map((s) => (
            <button key={s} onClick={() => push({ sort: s === "recent" ? "recent" : "" })}
                    className={cx("px-3 py-2", sort === s ? "bg-brand text-white" : "bg-surface text-ink-2 hover:bg-surface-2")}>
              {s === "recent" ? "최신순" : "관련도순"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-4 self-start lg:sticky lg:top-4">
          {data && FILTERS.map((f) => {
            const counts = Object.entries(data.facets[f]).sort((a, b) => b[1] - a[1]);
            if (!counts.length) return null;
            const label = (k: string) => (f === "product" ? k : (data.labels[f as "kind" | "space" | "disclosure"]?.[k] ?? k));
            return (
              <div key={f}>
                <div className="mb-1.5 text-[12px] font-semibold text-ink-3">{FILTER_TITLE[f]}</div>
                <div className={cx("flex flex-wrap gap-1 lg:flex-col lg:gap-0.5", f === "product" && "lg:max-h-[220px] lg:overflow-auto")}>
                  {counts.map(([k, n]) => (
                    <button key={k} onClick={() => push({ [f]: filters[f] === k ? "" : k })}
                            className={cx("flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]",
                              filters[f] === k ? "bg-brand-soft font-semibold text-brand-ink" : "text-ink-2 hover:bg-surface-2")}>
                      <span className="flex-1 truncate">{label(k)}</span>
                      <span className="text-[11.5px] text-ink-3">{n}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </aside>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <span>{data ? `${data.total.toLocaleString()}건` : " "}</span>
            {data?.loose && <span className="rounded-md bg-warn-soft px-1.5 py-0.5 text-warn">모든 단어가 들어간 문서가 없어, 일부 단어만 맞는 결과입니다</span>}
            {active.map((f) => (
              <button key={f} onClick={() => push({ [f]: "" })} className="rounded-full border border-line-strong px-2 py-0.5 hover:bg-surface-2">
                {FILTER_TITLE[f]}: {f === "product" ? filters[f] : (data?.labels[f as "kind" | "space" | "disclosure"]?.[filters[f]] ?? filters[f])} ×
              </button>
            ))}
          </div>
          <Card pad={false}>
            {res.loading && !data ? <Skeleton rows={6} /> : data?.items.length ? (
              <div>
                {data.items.map((h) => <Hit key={h.id} h={h} kindLabel={data.labels.kind[h.kind] ?? h.kind} />)}
                {data.items.length < data.total && (
                  <button onClick={() => setLimit((l) => l + PAGE)}
                          className="block w-full px-5 py-3 text-center text-[13px] font-semibold text-brand-ink hover:bg-surface-2">
                    더 보기 (남은 {(data.total - data.items.length).toLocaleString()}건)
                  </button>
                )}
              </div>
            ) : (
              <Empty>{sp.get("q") || active.length ? "찾는 문서가 없습니다 — 다른 표현(영어 · 모델명)으로 찾아보거나 LLM Wiki 에 물어보세요" : "문서가 없습니다"}</Empty>
            )}
          </Card>
          {res.error && <p className="mt-3 text-[13px] text-err">{res.error}</p>}
        </div>
      </div>
    </>
  );
}

const KIND_TONE: Record<string, string> = {
  resolution: "bg-info-soft text-info",
  troubleshooting: "bg-warn-soft text-warn",
  how_to: "bg-ok-soft text-ok",
  guide: "bg-muted-soft text-ink-2",
};

function Hit({ h, kindLabel }: { h: FaqHit; kindLabel: string }) {
  return (
    <Link href={`/faq/${h.id}`} className="block border-b border-line px-5 py-3.5 last:border-b-0 hover:bg-surface-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cx("rounded-md px-1.5 py-0.5 text-[11px] font-semibold", KIND_TONE[h.kind] ?? KIND_TONE.guide)}>{kindLabel}</span>
        <DisclosureTag v={h.disclosure} />
        {h.products.slice(0, 4).map((p) => <span key={p} className="rounded-md border border-line px-1.5 text-[11px] text-ink-2">{p}</span>)}
        {h.products.length > 4 && <span className="text-[11px] text-ink-3">+{h.products.length - 4}</span>}
        <span className="ml-auto text-[11.5px] text-ink-3">{kst(h.updated_at).slice(0, 10)}</span>
      </div>
      <div className="mt-1 text-[14.5px] font-semibold leading-snug text-ink">{h.title}</div>
      {h.applies_to && <div className="mt-0.5 truncate text-[12.5px] text-ink-3">Applies to · {h.applies_to}</div>}
      {h.snippets.length > 0 && (
        <div className="mt-1 line-clamp-2 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-2"
             dangerouslySetInnerHTML={{ __html: h.snippets.join(" … ") }} />
      )}
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11.5px] text-ink-3">
        {h.category && <span>{h.category}</span>}
        {h.redmine_issue_ids.slice(0, 3).map((n) => <span key={n}>#{n}</span>)}
      </div>
    </Link>
  );
}
