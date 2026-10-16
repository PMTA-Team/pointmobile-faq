/**
 * Redmine REST(.json) 클라이언트 — **GET 전용**.
 *
 * 등록된 'redmine' 계정(ID/PW)을 Basic 인증에 쓴다. GET 외의 메서드는 두지 않는다 —
 * Redmine 에 쓰기를 시도하는 코드가 실수로도 생기지 않게.
 */
import { getWebConfig } from "../creds";

export const TARGET = "redmine";
export const PROJECT = process.env.TW_REDMINE_PROJECT || "salesissue";

const TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100; // Redmine 이 허용하는 limit 상한
const RETRY = 3;
const UA = "TA-FAQ/1.0 (issue monitor; read-only)";

export class RedmineError extends Error {}

const NO_ACCOUNT =
  "'redmine' 계정이 없습니다. [설정 → Redmine]에서 아이디/비밀번호를 등록하세요.";

/** 등록된 base_url 이 경로/쿼리를 포함할 수 있어 scheme+host 까지만 남긴다. */
export function normBase(raw: string): string {
  const s = (raw || "").trim();
  try {
    const u = new URL(s);
    if (u.protocol && u.host) return `${u.protocol}//${u.host}`;
  } catch {
    /* 아래로 */
  }
  return s.split("#")[0].split("?")[0].replace(/\/+$/, "");
}

export async function baseUrl(): Promise<string> {
  const cfg = await getWebConfig(TARGET);
  if (!cfg || !cfg.baseUrl) throw new RedmineError(NO_ACCOUNT);
  return normBase(cfg.baseUrl);
}

/** 이슈 웹 링크 만들기 — base 를 한 번 읽어 여러 번 쓴다. 모델이 호스트명을 지어내지 않게 코드가 만든다. */
export async function issueUrlMaker(): Promise<(id: number) => string> {
  let base = "";
  try {
    base = await baseUrl();
  } catch {
    base = "";
  }
  return (id: number) => (base ? `${base}/issues/${id}` : `/issues/${id}`);
}

export async function issueUrl(id: number): Promise<string> {
  return (await issueUrlMaker())(id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export class RedmineClient {
  private constructor(public base: string, private auth: string) {}

  static async create(): Promise<RedmineClient> {
    const cfg = await getWebConfig(TARGET);
    if (!cfg || !cfg.baseUrl) throw new RedmineError(NO_ACCOUNT);
    const auth = "Basic " + Buffer.from(`${cfg.username || ""}:${cfg.password || ""}`).toString("base64");
    return new RedmineClient(normBase(cfg.baseUrl), auth);
  }

  private async get(path: string, params: Record<string, string | number> = {}): Promise<Json> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let last: Error | null = null;
    for (let attempt = 0; attempt < RETRY; attempt++) {
      let r: Response | null = null;
      try {
        r = await fetch(url, {
          headers: { Authorization: this.auth, Accept: "application/json", "User-Agent": UA },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (e) {
        last = e instanceof Error ? e : new Error(String(e)); // 네트워크 단절 · 시간 초과
      }
      if (r) {
        if (r.status === 200) {
          const t = await r.text();
          try {
            return JSON.parse(t) as Json;
          } catch {
            throw new RedmineError(`${path}: JSON 아님 (${t.slice(0, 120)})`);
          }
        }
        if (r.status === 401 || r.status === 403)
          throw new RedmineError(`${path}: 인증 실패(${r.status}). Redmine 계정/비밀번호를 확인하세요.`);
        if (r.status === 404) throw new RedmineError(`${path}: 없음(404)`);
        last = new RedmineError(`${path}: HTTP ${r.status}`);
      }
      // 5xx · 시간 초과만 재시도. 짧게 물러난다.
      if (attempt < RETRY - 1) await sleep(1500 * (attempt + 1));
    }
    throw new RedmineError(String(last?.message ?? last));
  }

  /**
   * 프로젝트 이슈를 페이지 단위로(열림/닫힘 모두). updatedSince 를 주면 그 뒤 갱신분만.
   * 정렬은 id 오름차순 — 수집 도중 누가 갱신해도 페이지 경계가 밀리지 않는다.
   */
  async *iterIssues(opts: { project?: string; updatedSince?: Date | null } = {}): AsyncGenerator<Json[]> {
    const params: Record<string, string | number> = {
      project_id: opts.project || PROJECT,
      status_id: "*", // 기본값은 열린 이슈만이라 반드시 지정
      sort: "id:asc",
      limit: PAGE_SIZE,
    };
    if (opts.updatedSince) params.updated_on = ">=" + fmtUtc(opts.updatedSince);
    let offset = 0;
    for (;;) {
      const data = await this.get("/issues.json", { ...params, offset });
      const rows: Json[] = data.issues || [];
      if (!rows.length) return;
      yield rows;
      offset += rows.length;
      if (offset >= Number(data.total_count || 0)) return;
    }
  }

  /** journals · attachments 를 포함한 이슈 상세. */
  async issueDetail(id: number): Promise<Json> {
    const data = await this.get(`/issues/${id}.json`, { include: "journals,attachments" });
    return data.issue || {};
  }

  /** 상태 · 우선순위 · 트래커 id→이름. 권한에 따라 막히면 빈 목록(수집은 계속). */
  async enumerations(): Promise<Record<string, Json[]>> {
    const out: Record<string, Json[]> = {};
    for (const [kind, path, key] of [
      ["status", "/issue_statuses.json", "issue_statuses"],
      ["priority", "/enumerations/issue_priorities.json", "issue_priorities"],
      ["tracker", "/trackers.json", "trackers"],
    ] as const) {
      try {
        out[kind] = (await this.get(path))[key] || [];
      } catch (e) {
        console.warn(`Redmine ${kind} 목록 조회 실패: ${e}`);
        out[kind] = [];
      }
    }
    return out;
  }

  /** 프로젝트 참여자 — journal detail 의 담당자 id 를 이름으로 바꾸는 데 쓴다. */
  async memberships(project = PROJECT): Promise<Json[]> {
    try {
      return (await this.get(`/projects/${project}/memberships.json`, { limit: PAGE_SIZE })).memberships || [];
    } catch (e) {
      console.warn(`Redmine memberships 조회 실패: ${e}`);
      return [];
    }
  }
}

function fmtUtc(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

/** Redmine 의 '2026-07-21T02:13:44Z' · '2026-07-21' → Date(UTC). */
export function parseDt(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 수집 상태 값(ISO 문자열) → Date. 예전 앱이 남긴 값은 시간대 표시 없는 UTC 다. */
export function parseStateDt(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s + "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}
