"use client";

import { ThemeCycle } from "./ThemeToggle";

/** 로그인 · 회원가입 화면의 바탕과 카드 머리 — 두 화면이 같은 모양을 쓴다. */
export function AuthShell({ sub, children }: { sub: string; children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-screen place-items-center px-4 py-10 bg-[radial-gradient(1200px_600px_at_20%_-10%,#ccfbf1_0%,transparent_60%)] dark:bg-[radial-gradient(1200px_600px_at_20%_-10%,#0f2e2b_0%,transparent_60%)]">
      <ThemeCycle className="absolute right-4 top-4 text-ink-3 hover:bg-surface-2 hover:text-ink" />
      <div className="w-[400px] max-w-full rounded-2xl border border-line bg-surface p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-[#14b8a6] to-[#0d9488] text-[13px] font-extrabold text-white">SB</span>
          <div>
            <div className="text-[16px] font-bold">TA FAQ</div>
            <div className="text-[12px] text-ink-3">{sub}</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export const authInput =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 outline-none focus:border-brand focus:ring-2 focus:ring-brand-soft";

export function AuthField({ id, label, hint, error, children }: {
  id: string; label: string; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold text-ink-2" htmlFor={id}>
        {label}{hint && <span className="text-[11.5px] font-normal text-ink-3">{hint}</span>}
      </label>
      {children}
      {error && <div className="mt-1 text-[12px] text-err">{error}</div>}
    </div>
  );
}
