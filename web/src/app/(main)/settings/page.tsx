"use client";

import Link from "next/link";
import { SetBadge } from "@/components/admin/kit";
import { Skeleton, cx } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { SettingsOverview, ShadowResp } from "@/lib/admin";

function Tile({ href, title, ok, okText, noText, children }: {
  href: string; title: string; ok: boolean; okText?: string; noText?: string; children?: React.ReactNode;
}) {
  return (
    <Link href={href} className="group rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(16,24,40,.05)] transition-colors hover:border-brand/50">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[14px] font-bold group-hover:text-brand-ink">{title}</span>
        <SetBadge ok={ok} okText={okText} noText={noText} />
      </div>
      {children && <div className="mt-2 space-y-0.5 text-[12.5px] text-ink-3">{children}</div>}
    </Link>
  );
}

export default function SettingsHome() {
  const { data: s, loading } = useApi<SettingsOverview>("/api/admin/settings");
  const sh = useApi<ShadowResp>("/api/shadow?limit=1", 30_000);
  if (loading || !s) return <Skeleton rows={6} />;
  const live = sh.data?.live;
  const loops = Object.entries(sh.data?.runtime.loops ?? {});
  return (
    <>
      <Link href="/settings/shadow"
            className={cx("block rounded-2xl border p-5", live ? "border-ok/40 bg-ok-soft" : "border-[#f2d49b] bg-[#fff7e6] dark:border-[#5a4310] dark:bg-[#2a2210]")}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={cx("text-[17px] font-bold", live ? "text-ok" : "text-[#8a5a00] dark:text-[#f0c36a]")}>
            {live === undefined ? "…" : live ? "운영 중 — 외부 시스템에 실제로 씁니다" : "검증 모드 — 외부 시스템에 쓰지 않고 기록만 합니다"}
          </span>
          <span className="ml-auto text-[12.5px] text-ink-2">
            주기 작업 {loops.length}개 · {loops.filter(([, v]) => v.ok).length}개 정상
          </span>
        </div>
      </Link>

      <div>
        <h2 className="mb-2 text-[13px] font-bold text-ink-3">연결</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {s.web.map((x) => (
            <Tile key={x.target} href="/settings/web" title={x.label} ok={x.has_password} noText="미등록">
              <div className="truncate">{x.username || "—"}</div>
            </Tile>
          ))}
          <Tile href="/settings/mail" title="메일 발송" ok={!!s.sender.system_from || s.sender.has_password} okText="사용 중">
            <div className="truncate">{s.sender.system_from_name} &lt;{s.sender.system_from || s.sender.email}&gt;</div>
          </Tile>
          <Tile href="/settings/claude" title="Claude 호출" ok={s.claude.has_key} okText="API 키" noText="키 없음" />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-[13px] font-bold text-ink-3">SB 문서</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Tile href="/settings/sb" title="초안 자동 생성" ok={s.sb.sb_auto_generate} okText={`한 번에 ${s.sb.sb_per_tick}건`} noText="꺼짐" />
          <Tile href="/settings/sb" title="담당자 검토 요청 메일" ok={s.sb.sb_auto_notify} okText="자동 발송" noText="수동 발송">
            <div className="truncate">대상 {s.sb.sb_assignees || "전체"}</div>
          </Tile>
          {s.sb.missing_accounts.length > 0 && (
            <Tile href="/settings/sb" title="계정 없는 담당자" ok={false} noText={`${s.sb.missing_accounts.length}명`}>
              <div className="truncate">{s.sb.missing_accounts.slice(0, 4).map((m) => m.name).join(", ")}</div>
            </Tile>
          )}
        </div>
      </div>
    </>
  );
}
