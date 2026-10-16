/**
 * SB 문서 동작 설정 — 화면에서 바꾸고 DB(sb.rm_sync_state, 키 'cfg.<이름>')에 남는다.
 * 우선순위: DB 에 저장된 값 > 환경변수 기본값 > 코드 기본값. 한 번 화면에서 바꾸면 환경변수를 고쳐도 안 바뀐다.
 */
import { sql } from "../db";

const PREFIX = "cfg.";

type Kind = "bool" | "int" | "str";
//: 키 → [환경변수, 코드 기본값, 형]
const DEFS: Record<string, [string, boolean | number | string, Kind]> = {
  sb_auto_generate: ["TW_SB_AUTO_GENERATE", true, "bool"],
  sb_auto_notify: ["TW_SB_AUTO_NOTIFY", false, "bool"],
  sb_per_tick: ["TW_SB_PER_TICK", 3, "int"],
  exclude_keywords: ["TW_REDMINE_EXCLUDE", "janam", "str"],
  // 이 날짜보다 전에 해결된 이슈는 SB 에 이미 정리돼 있다고 보고 소급 대상에서 뺀다. 빈 값이면 컷오프 없음.
  sb_cutoff: ["TW_SB_CUTOFF", "2026-04-22", "str"],
  // SB 문서는 TA 팀 전용 — 여기 적힌 Redmine 담당자의 이슈만 문서를 만든다. 빈 값이면 가리지 않는다.
  sb_assignees: ["TW_SB_ASSIGNEES", "daniel.chae,samuel.seo,jayden.lee,damon.park", "str"],
};

function cast(raw: string, kind: Kind, fallback: boolean | number | string) {
  const s = (raw ?? "").trim();
  if (kind === "bool") return !["0", "false", "no", "off", ""].includes(s.toLowerCase());
  if (kind === "int") {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) && /^-?\d+$/.test(s) ? n : fallback;
  }
  return s;
}

function envDefault(key: string) {
  const [env, fallback, kind] = DEFS[key];
  const raw = process.env[env];
  return raw === undefined ? fallback : cast(raw, kind, fallback);
}

/** 설정 전부를 한 번에 읽는다(한 줄 조회). DB 를 못 읽어도 기본값으로 돈다. */
async function readAll(): Promise<Record<string, boolean | number | string>> {
  let stored: Record<string, string | null> = {};
  try {
    const rows = await sql<{ key: string; value: string | null }[]>`
      SELECT key, value FROM sb.rm_sync_state WHERE key LIKE ${PREFIX + "%"}`;
    stored = Object.fromEntries(rows.map((r) => [r.key.slice(PREFIX.length), r.value]));
  } catch {
    stored = {};
  }
  const out: Record<string, boolean | number | string> = {};
  for (const [key, [, fallback, kind]] of Object.entries(DEFS)) {
    const v = stored[key];
    out[key] = v !== undefined && v !== null ? cast(v, kind, fallback) : envDefault(key);
  }
  return out;
}

export type SbSettings = {
  sb_auto_generate: boolean;
  sb_auto_notify: boolean;
  sb_per_tick: number;
  exclude_keywords: string;
  sb_cutoff: string;
  sb_assignees: string;
};

export async function loadSbSettings(): Promise<SbSettings> {
  const v = await readAll();
  return {
    sb_auto_generate: Boolean(v.sb_auto_generate),
    sb_auto_notify: Boolean(v.sb_auto_notify),
    sb_per_tick: Math.max(1, Number(v.sb_per_tick) || 1),
    exclude_keywords: String(v.exclude_keywords),
    sb_cutoff: String(v.sb_cutoff),
    sb_assignees: String(v.sb_assignees),
  };
}

export async function setSbSetting(key: string, value: boolean | number | string): Promise<void> {
  const def = DEFS[key];
  if (!def) throw new Error(`모르는 설정입니다: ${key}`);
  const raw = def[2] === "bool" ? (value ? "1" : "0") : String(value);
  await sql`
    INSERT INTO sb.rm_sync_state (key, value, updated_at) VALUES (${PREFIX + key}, ${raw}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** SB 대상 담당자(소문자). 빈 집합이면 담당자를 가리지 않는다. */
export function assigneeSet(cfg: SbSettings): Set<string> {
  return new Set(
    String(cfg.sb_assignees || "")
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** 소급 기준일(UTC 자정). 이 날짜보다 전에 해결된 건은 SB 문서를 만들지 않는다. */
export function cutoffDate(cfg: SbSettings): Date | null {
  const raw = String(cfg.sb_cutoff || "").trim();
  if (!raw) return null;
  const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function excludeList(cfg: SbSettings): string[] {
  return String(cfg.exclude_keywords)
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}
