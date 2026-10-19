"use client";

import { api } from "./api";

/** JSON 으로 보내고 받는다 — 실패하면 서버가 준 사유를 그대로 던진다 */
export function send<T = { ok: boolean; message?: string }>(path: string, body?: unknown, method = "POST") {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ── 응답 타입 ────────────────────────────────────────────────────────────────

export type CredRow = { target: string; label: string; username: string; has_password: boolean; updated_at: string; base_url?: string; host?: string };

export type SettingsOverview = {
  is_admin: boolean;
  sender: {
    relay_owner: boolean; relay: boolean; my_address: string; system_from: string; system_from_name: string;
    email: string; has_password: boolean;
  };
  web: CredRow[];
  claude: { backend: "api"; claude: string; has_key: boolean; model?: string };
  sb: {
    sb_auto_notify: boolean; sb_assignees: string; exclude_keywords: string; sb_auto_generate: boolean; sb_per_tick: number;
    missing_accounts: { name: string; count: number }[];
  };
};

export type ShadowWrite = { at: string; system: string; action: string; [k: string]: unknown };
export type ShadowResp = {
  live: boolean;
  writes: ShadowWrite[];
  runtime: { started_at: string; loops: Record<string, { ok: boolean; at: string; error?: string }> };
};

export type AccountStatus = "pending" | "approved" | "rejected";
export type Account = {
  id: number; username: string; role: string; must_change: boolean; email: string; me: boolean;
  status: AccountStatus; company: string; requested_at: string; decided_by: string; decided_at: string; reject_reason: string;
};
export type AccountsResp = {
  roles: Record<string, string>; statuses: Record<AccountStatus, string>; users: Account[];
  system_from: string; system_from_name: string; initial_password: string;
};

export type UsageBucket = { cost: number; tokens: number; calls: number };
export type UsageResp = {
  totals: { today: UsageBucket; month: UsageBucket; all: UsageBucket };
  by_day: ({ day: string } & UsageBucket)[];
  by_month: ({ month: string } & UsageBucket)[];
  by_operation: ({ operation: string } & UsageBucket)[];
  recent: { ts: string; model: string; operation: string; input_tokens: number; output_tokens: number; cost_usd: number }[];
  scope: string;
};

export function usd(v: number) {
  v = Number(v || 0);
  return v >= 1 ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${v.toFixed(4)}`;
}

export function num(v: number) {
  return Math.round(Number(v || 0)).toLocaleString();
}
