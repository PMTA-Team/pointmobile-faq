"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, useApi, type Me } from "@/lib/api";
import type { IssueOverview } from "@/lib/issues";
import { Icon } from "./Icons";
import { ThemeCycle, ThemeSwitch } from "./ThemeToggle";
import { cx } from "./ui";

type NavItem = {
  href: string; label: string; icon: string; hot?: boolean;
  count?: (o?: IssueOverview | null, m?: Me | null) => number;
};

// 묶음(label 이 있으면 머리글을 단다) → 메뉴. 업로드 = Redmine 이슈로 SB 문서를 만들어 확정하기까지.
const NAV: { label?: string; icon?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/faq", label: "FAQ", icon: "help" },
      { href: "/wiki", label: "LLM Wiki", icon: "chat" },
    ],
  },
  {
    label: "업로드", icon: "upload",
    items: [
      { href: "/sb", label: "SB 문서", icon: "file", count: (o) => o?.sb_open ?? 0, hot: true },
      { href: "/issues", label: "이슈", icon: "bug" },
      { href: "/stats", label: "통계", icon: "rounds" },
    ],
  },
  {
    items: [
      { href: "/usage", label: "Claude 사용량", icon: "sparkle" },
      { href: "/settings", label: "설정", icon: "gear", count: (_o, m) => m?.pending_signups ?? 0, hot: true },
    ],
  },
];

const ROLE: Record<string, string> = { admin: "관리자", user: "담당자" };

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const me = useApi<Me>("/api/me", 60_000);   // 가입 승인 대기 숫자가 따라오게
  const ov = useApi<IssueOverview>("/api/issues/overview", 30_000);

  async function logout() {
    await api("/api/logout", { method: "POST" });
    router.replace("/login");
  }

  const name = me.data?.username ?? "";
  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 z-10 flex flex-col gap-1 border-b border-side-line bg-side px-3 py-4 text-side-text lg:h-screen lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center">
        <Link href="/faq" className="flex flex-1 items-center gap-2.5 px-2 text-side-strong">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[#14b8a6] to-[#0d9488] text-[13px] font-extrabold text-white">TA</span>
          <span>
            <span className="block text-[15px] font-bold leading-tight">TA FAQ</span>
            <span className="block text-[11px] text-side-dim">이슈 기록 · 해결 가이드</span>
          </span>
        </Link>
        <ThemeCycle className="text-side-dim hover:bg-side-hover hover:text-side-strong lg:hidden" />
        </div>
        <nav className="flex flex-row flex-wrap gap-1 lg:flex-col">
          {NAV.map((g, gi) => (
            <div key={g.label ?? gi} className={cx("contents lg:block", gi > 0 && "lg:mt-2")}>
              {g.label && (
                <div className="hidden items-center gap-2 px-2.5 pb-1 pt-1 text-[11.5px] font-semibold uppercase tracking-wide text-side-dim lg:flex">
                  {g.icon && <Icon name={g.icon} className="h-3.5 w-3.5" />}
                  {g.label}
                </div>
              )}
              {g.items.map((n) => {
                const active = path === n.href || path.startsWith(n.href + "/");
                const c = n.count?.(ov.data, me.data) ?? 0;     // 설정의 숫자 = 가입 승인 대기(관리자)
                return (
                  <Link key={n.href} href={n.href}
                        className={cx("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors",
                          g.label && "lg:pl-5",
                          active ? "bg-side-active font-semibold text-side-active-text" : "hover:bg-side-hover hover:text-side-strong")}>
                    <Icon name={n.icon} className="h-[18px] w-[18px] opacity-85" />
                    <span className="flex-1">{n.label}</span>
                    {c > 0 && <span className={cx("rounded-full px-2 text-[11px] font-bold", n.hot ? "bg-[#d97706] text-white" : "text-side-dim")}>{c}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-side-line pt-3 lg:block">
          <ThemeSwitch className="mb-2" />
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-side-chip text-[12px] font-bold text-side-chip-text">{name.slice(0, 2).toUpperCase()}</span>
            <span className="flex-1 leading-tight">
              <span className="block truncate text-[13px] text-side-strong">{name}</span>
              <span className="block text-[11px] text-side-dim">{ROLE[me.data?.role ?? ""] ?? me.data?.role}</span>
            </span>
            <button onClick={logout} title="로그아웃" className="rounded-md p-1.5 text-side-dim hover:bg-side-hover hover:text-side-strong">
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0">
        {me.data && !me.data.live && (
          <Link href="/settings/shadow" className="block border-b border-[#f2d49b] bg-[#fff7e6] px-4 py-2 text-[13px] text-[#8a5a00] lg:px-8 dark:border-[#5a4310] dark:bg-[#2a2210] dark:text-[#f0c36a]">
            <b>검증 모드</b> — 메일을 실제로 보내지 않고 기록만 합니다. 기록 보기 →
          </Link>
        )}
        <div className="mx-auto w-full max-w-[1280px] px-4 py-7 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
