/**
 * Resolved 이슈 → SB 문서 초안 → 담당자 검토 요청 메일 → 확정.
 *
 * 흐름
 *   1. scan()      상태가 Resolved 인 이슈를 훑어 문서 행을 만든다(Claude 는 부르지 않는다).
 *                  감시 시작(워터마크) 이후 해결된 것 = queued(자동 생성), 그 전 것 = backlog(수동).
 *   2. generate()  queued/backlog 행 하나를 Claude 로 채운다(제목 · 공개 등급 · 본문을 한 번에).
 *   3. notify()    초안이 만들어진 그 자리에서 담당자에게 메일. 이 기능의 본줄기다.
 *   4. approve()   담당자가 내용을 확정한다(approved). 확정된 문서가 SB 의 결과물이다.
 *
 * 과거분을 자동으로 돌리지 않는 이유: 감시를 켠 시점에 이미 Resolved 인 이슈가 수백 건이다. 무심코 전부
 * 돌리면 비용이 한 번에 나간다. 소급은 사람이 건수를 보고 정할 일이라 backlog 로 남겨 둔다.
 *
 * 읽기 전용 원칙: Redmine 에는 아무것도 쓰지 않는다.
 *
 * '만드는 중' 표시는 예전에는 프로세스 메모리에 있었다. 서버리스는 요청마다 인스턴스가 달라
 * rm_sb_docs.generating_since 에 남긴다(GEN_WINDOW 안이면 만드는 중으로 본다 — 함수가 도중에 죽어도 풀린다).
 */
import { z } from "zod";
import { MODEL, parseStructured } from "../claude";
import { sql } from "../db";
import { publishSbDoc, unpublishSbDoc } from "../kb/publish";
import { isLocked, withLock } from "../locks";
import { price } from "../usage";
import { issueUrlMaker } from "./client";
import { eventOf, Naming, timings } from "./events";
import { assigneeSet, cutoffDate, loadSbSettings } from "./settings";
import { byTime, issueWithJournals, journalsFor, pyDt, withJournals, type IssueRow, type IssueWithJournals } from "./store";

/** 공개 등급 → 한글 이름. */
export const DISCLOSURES: Record<string, string> = {
  public: "전체 공개",
  partner: "파트너 공개",
  ascp: "ASC/ASP 공개",
  internal: "내부 공유",
};

/** partner 등급일 때 공개 대상. 화면에서 담당자가 고른다. */
export const PARTNER_CHOICES: Record<string, string> = {
  pm_global_korea: "일반 파트너 (pm_global & pm_korea)",
  pm_amazon: "Amazon (pm_amazon)",
};

//: 이슈 본문 · 이력이 아주 긴 것이 있어 프롬프트 상한을 둔다(입력 토큰 = 비용).
const MAX_DESC = 6000;
const MAX_NOTE = 2000;
const MAX_TOTAL = 60000;
const MAX_TOKENS = 16000;

export const K_WATERMARK = "sb_watermark";
export const GEN_LOCK = "sb_generate";
/** 이 시간 안에 시작한 생성은 '만드는 중'으로 본다. */
export const GEN_WINDOW_MIN = 10;

export const SBDraft = z.object({
  title: z.string().describe(
    "SB 문서 제목. 자연어 질문형 또는 설명형. 이슈 제목의 [Issue][PM95] 같은 " +
      "대괄호 태그는 제거한다. Redmine 번호는 제목에 넣지 않는다.",
  ),
  is_troubleshooting: z.boolean().describe("장애 해결(Troubleshooting) 성격이면 true. 제목 앞에 [TR] 이 붙는다."),
  disclosure: z.string().describe("공개 등급. internal | public | partner | ascp 중 하나."),
  disclosure_reason: z.string().describe("그 등급을 고른 이유 한 문장."),
  applies_to: z.string().describe("'1) Applies to' 값. 적용 모델/솔루션. 예: 'PM95 / Android 15, EmKit'"),
  description_html: z.string().describe(
    "'2) Description' 본문. 평범한 HTML 로 쓴다 — " +
      "<p>, <ul>, <ol>, <li>, <strong>, <em>, <table>, <tr>, <th>, <td>, <br>, " +
      "<a href> 만 사용한다. 배경 → 증상 → 원인 → 해결 순서로 쓴다. " +
      "Redmine 이슈 번호와 링크를 반드시 포함한다.",
  ),
});

export const SYSTEM = `당신은 Point Mobile 기술지원팀의 Solution Buffer(SB) 문서 작성자입니다.
Redmine 이슈가 Resolved 되면 그 내용을 사내 FAQ(TA FAQ)에 올릴 문서로 정리합니다.

SB 문서 규칙:
- 제목은 자연어(질문형 또는 설명형). 이슈 제목의 [Issue][PM95] 같은 태그는 넣지 않는다.
  예: "PM68에서 지원하는 Ethernet chipset 정보", "TR54의 EID 교체가 가능한가요?"
- Troubleshooting(장애 해결) 성격이면 is_troubleshooting=true (제목 앞에 [TR] 이 붙는다).
- 본문은 두 부분:
    1) Applies to : 어떤 모델/솔루션에 적용되는지
    2) Description : 배경(왜 발생했는지) · 증상 · 원인 · 해결. Redmine 번호와 링크 포함.
- 첨부파일은 **파일명만** 언급한다. 업로드하지 않는다.
- 이슈 이력에 나오는 사내 구성원 실명·직급 호칭, 고객사 담당자 이름은 문서에 옮기지 않는다.
- 추측하지 않는다. 이슈에 근거가 없는 원인·수치·버전은 쓰지 않는다.

공개 등급 판단:
- internal : 내부에서만 봐야 할 것. 미출시 정보, 원인이 자사 결함으로 드러난 것,
             고객사명·계약 정보가 얽힌 것, 아직 확정되지 않은 내용
- public   : 제약 없이 공개 가능한 일반 사용법·스펙·설정 방법
- partner  : 파트너에게만 유용한 설정/운영 정보
- ascp     : ASC/ASP(서비스 협력사) 대상 수리·진단 정보
확신이 서지 않으면 더 보수적인 쪽(internal)을 고른다.`;

export type SbDocRow = {
  id: number;
  issue_id: number;
  revision: number;
  superseded: boolean;
  state: string;
  origin: string;
  source_resolved_at: Date | null;
  title: string;
  is_troubleshooting: boolean;
  disclosure: string;
  disclosure_reason: string | null;
  applies_to: string | null;
  description_html: string | null;
  partners_json: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
  generating_since: Date | null;
  created_at: Date | null;
  generated_at: Date | null;
  notified_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
};

// ── 상태 ────────────────────────────────────────────────────────────────────

async function getState(key: string): Promise<string | null> {
  const [r] = await sql<{ value: string | null }[]>`SELECT value FROM sb.rm_sync_state WHERE key = ${key}`;
  return r?.value ?? null;
}

async function setState(key: string, value: string | null): Promise<void> {
  await sql`
    INSERT INTO sb.rm_sync_state (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** 감시 시작 시각. 이 시각 이후 Resolved 된 것만 자동 생성 대상. 예전 앱이 남긴 값은 시간대 없는 UTC. */
export async function watermark(): Promise<Date | null> {
  const v = await getState(K_WATERMARK);
  if (!v) return null;
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : v + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isGenerating(d: { generating_since: Date | null }): boolean {
  return Boolean(d.generating_since && Date.now() - d.generating_since.getTime() < GEN_WINDOW_MIN * 60_000);
}

// ── 대상 ────────────────────────────────────────────────────────────────────

/** Redmine 담당자 이름 → 사내 메일 주소. 계정명이 메일 로컬파트와 같다(samuel.seo). 못 만들면 ''. */
export function assigneeEmail(name: string | null): string {
  const n = (name || "").trim();
  if (!n || !/^[A-Za-z0-9._-]+$/.test(n)) return "";
  return `${n.toLowerCase()}@pointmobile.com`;
}

const sameTime = (a: Date | null, b: Date | null) =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * Resolved 이슈를 훑어 문서 행을 만든다. Claude 는 부르지 않는다.
 * 최초 실행 때 워터마크를 '지금'으로 찍는다 — 그때 이미 Resolved 인 것은 backlog, 이후 해결분만 queued.
 * 소급 기준일보다 전에 해결된 건은 not_needed. 아직 만들지 않은 행은 매번 기준일 · 담당자 설정으로 다시 매긴다.
 */
export async function scan() {
  const cfg = await loadSbSettings();
  const firstRun = (await watermark()) === null;
  if (firstRun) await setState(K_WATERMARK, new Date().toISOString());
  const mark = await watermark();
  const cutoff = cutoffDate(cfg);
  const ta = assigneeSet(cfg);

  const naming = await Naming.load();
  let addedQueued = 0, addedBacklog = 0, addedSkip = 0, superseded = 0, restated = 0;

  const isTarget = (assignee: string | null) => !ta.size || ta.has((assignee || "").trim().toLowerCase());
  const wanted = (lr: Date | null, assignee: string | null) => {
    if (!isTarget(assignee)) return "not_target";
    if (cutoff && lr && lr < cutoff) return "not_needed";
    return "backlog";
  };

  const issues = await sql<IssueRow[]>`SELECT * FROM sb.rm_issues WHERE NOT excluded AND status = 'Resolved'`;
  const full = withJournals([...issues], await journalsFor(issues.map((i) => i.id)));
  const latest = new Map(
    (
      await sql<SbDocRow[]>`
        SELECT DISTINCT ON (issue_id) * FROM sb.rm_sb_docs
        WHERE issue_id = ANY(${issues.map((i) => i.id)}::int[])
        ORDER BY issue_id, revision DESC`
    ).map((d) => [d.issue_id, d]),
  );

  await sql.begin(async (tx) => {
    for (const issue of full) {
      // 상태가 Resolved 인데 그렇게 바뀐 이력이 없으면(이관 · 직접 생성) 생성 시각으로 대신한다.
      const lr = timings(issue, naming).last_resolved_at ?? issue.created_on;
      const prev = latest.get(issue.id);

      if (prev && sameTime(prev.source_resolved_at, lr)) {
        // 이미 이 해결분으로 만든 행이 있다. 사람 손을 타지 않았다면 기준일 · 담당자 설정으로 다시 매긴다.
        // 알림을 보냈거나 확정한 건은 건드리지 않는다.
        if (["backlog", "not_needed", "not_target", "queued", "draft"].includes(prev.state)) {
          let want = wanted(lr, prev.assignee_name);
          if (want === "backlog" && prev.generated_at) want = "draft"; // 만들어 둔 초안은 살려 둔다
          if (prev.state !== want) {
            await tx`UPDATE sb.rm_sb_docs SET state = ${want} WHERE id = ${prev.id}`;
            restated++;
          }
        }
        continue;
      }

      if (prev) {
        await tx`UPDATE sb.rm_sb_docs SET superseded = true WHERE id = ${prev.id}`; // ReOpen 후 재해결 → 새 개정판
        superseded++;
      }

      const queued = Boolean(isTarget(issue.assigned_to_name) && mark && lr && lr >= mark);
      const state = queued ? "queued" : wanted(lr, issue.assigned_to_name);
      await tx`
        INSERT INTO sb.rm_sb_docs (issue_id, revision, state, origin, source_resolved_at, assignee_name, assignee_email, created_at)
        VALUES (${issue.id}, ${prev ? prev.revision + 1 : 1}, ${state}, ${queued ? "auto" : "backlog"}, ${lr},
                ${issue.assigned_to_name}, ${assigneeEmail(issue.assigned_to_name)}, now())`;
      if (queued) addedQueued++;
      else if (state === "backlog") addedBacklog++;
      else addedSkip++;
    }
  });

  if (addedQueued || addedBacklog || superseded || restated)
    console.info(`SB scan: queued=${addedQueued} backlog=${addedBacklog} 소급불필요=${addedSkip} 재분류=${restated} superseded=${superseded}`);
  return { queued: addedQueued, backlog: addedBacklog, not_needed: addedSkip, restated, superseded, first_run: firstRun };
}

// ── 프롬프트 ───────────────────────────────────────────────────────────────

/** 이슈 전문을 Claude 에게 넘길 평문으로. 저장된 데이터만 쓴다(재조회 없음). */
export function issueText(issue: IssueWithJournals, naming: Naming, url: (id: number) => string): string {
  const parts = [
    `[Redmine #${issue.id}] ${issue.subject}`,
    `링크: ${url(issue.id)}`,
    `상태: ${issue.status} / 우선순위: ${issue.priority} / 카테고리: ${issue.category || "-"}`,
    `작성자: ${issue.author_name} / 담당자: ${issue.assigned_to_name}`,
    `생성: ${pyDt(issue.created_on)} / 최종갱신: ${pyDt(issue.updated_on)}`,
  ];
  let cfs: { name?: string; value?: unknown }[] = [];
  try {
    cfs = JSON.parse(issue.custom_fields_json || "[]");
  } catch {
    cfs = [];
  }
  for (const f of cfs) {
    if (f.value && String(f.value).trim().toUpperCase() !== "NA")
      parts.push(`${String(f.name ?? "").trim()}: ${Array.isArray(f.value) ? pyList(f.value) : f.value}`);
  }
  parts.push("\n[설명]\n" + (issue.description || "(없음)").slice(0, MAX_DESC));
  parts.push("\n[진행 이력]");
  for (const j of [...issue.journals].sort(byTime)) {
    const ev = eventOf(j, naming);
    let line = `- ${pyDt(ev.at)} ${ev.who}`;
    if (ev.summary) line += ` [${ev.summary}]`;
    if (ev.note) line += "\n    " + ev.note.slice(0, MAX_NOTE);
    parts.push(line);
  }
  let text = parts.join("\n");
  if (text.length > MAX_TOTAL) {
    // 앞(배경)과 뒤(해결)가 중요하므로 가운데를 자른다.
    text = text.slice(0, MAX_TOTAL / 2) + "\n\n…(중략)…\n\n" + text.slice(-(MAX_TOTAL / 2));
  }
  return text;
}

/** Python 리스트 표기(['a', 'b']) — 예전 프롬프트와 같은 모양. */
function pyList(v: unknown[]): string {
  return "[" + v.map((x) => (typeof x === "string" ? `'${x}'` : String(x))).join(", ") + "]";
}

const ALLOWED_TAG = /^<\/?(?:p|br|ul|ol|li|strong|em|b|i|code|pre|table|thead|tbody|tr|th|td|h[1-6]|a|span|div)\b[^>]*>$/i;

/** 본문에서 위험하거나 뜻 없는 태그를 걷어낸다(script · iframe 등). 문법 교정은 하지 않는다. */
export function sanitizeHtml(html: string | null | undefined): string {
  let out = (html || "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  return out.replace(/<[^>]+>/g, (m) => (ALLOWED_TAG.test(m) ? m : "")).trim();
}

// ── 초안 생성 ──────────────────────────────────────────────────────────────

/** 문서 한 건을 Claude 로 채운다. 끝나면(성공 · 실패 모두) generating_since 를 지운다. */
export async function generate(docId: number): Promise<{ ok: boolean; error?: string; doc_id?: number; title?: string; disclosure?: string }> {
  try {
    const [doc] = await sql<SbDocRow[]>`SELECT * FROM sb.rm_sb_docs WHERE id = ${docId}`;
    if (!doc) return { ok: false, error: "문서를 찾을 수 없습니다." };
    if (!["backlog", "queued", "error"].includes(doc.state)) return { ok: false, error: `이미 처리된 문서입니다(state=${doc.state}).` };
    const issue = await issueWithJournals(doc.issue_id);
    if (!issue) return { ok: false, error: "이슈를 찾을 수 없습니다." };
    const prompt = issueText(issue, await Naming.load(), await issueUrlMaker());

    const res = await parseStructured({
      system: SYSTEM,
      prompt: `아래 Redmine 이슈를 SB 문서로 정리하세요.\n\n${prompt}`,
      schema: SBDraft,
      operation: "SB 문서 초안",
      maxTokens: MAX_TOKENS,
    });
    if (!res.ok) {
      await markError(docId, res.refusal ? res.error : `Claude 호출 실패: ${res.error}`);
      return { ok: false, error: res.error, doc_id: docId };
    }
    const d = res.data;
    const disclosure = d.disclosure in DISCLOSURES ? d.disclosure : "internal";
    const title = (d.is_troubleshooting ? "[TR] " : "") + d.title.trim();
    await sql`
      UPDATE sb.rm_sb_docs SET
        title = ${title}, is_troubleshooting = ${Boolean(d.is_troubleshooting)}, disclosure = ${disclosure},
        disclosure_reason = ${d.disclosure_reason}, applies_to = ${d.applies_to},
        description_html = ${sanitizeHtml(d.description_html)}, model = ${res.model || MODEL},
        input_tokens = ${res.usage.input_tokens}, output_tokens = ${res.usage.output_tokens},
        error = NULL, state = 'draft', generated_at = now()
      WHERE id = ${docId}`;
    console.info(`SB 초안 생성: #${doc.issue_id} rev${doc.revision} ${title.slice(0, 60)}`);
    return { ok: true, doc_id: docId, title, disclosure };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markError(docId, msg).catch(() => {});
    return { ok: false, error: msg, doc_id: docId };
  } finally {
    await sql`UPDATE sb.rm_sb_docs SET generating_since = NULL WHERE id = ${docId}`.catch(() => {});
  }
}

async function markError(docId: number, msg: string): Promise<void> {
  console.warn(`SB 초안 생성 실패(doc ${docId}): ${msg}`);
  await sql`UPDATE sb.rm_sb_docs SET state = 'error', error = ${msg.slice(0, 2000)} WHERE id = ${docId}`;
}

/**
 * 대기 중인 문서를 차례로 만든다(cron 한 번에 limit 건까지). Claude 호출은 건당 수십 초 · 수십 원이라 몰아 치지 않는다.
 * deadline 전에 한 건을 끝낼 여유(minLeftMs)가 없으면 멈춘다 — 남은 것은 다음 cron 이 이어서 한다.
 */
export async function generatePending(opts: {
  limit?: number;
  states?: string[];
  assignee?: string;
  deadline?: number;
  minLeftMs?: number;
} = {}) {
  const limit = opts.limit ?? 5;
  const states = opts.states ?? ["queued"];
  const minLeft = opts.minLeftMs ?? 150_000;
  const res = await withLock(GEN_LOCK, 20 * 60, async () => {
    const ids = (
      await sql<{ id: number }[]>`
        SELECT id FROM sb.rm_sb_docs
        WHERE state = ANY(${states}::text[]) ${opts.assignee ? sql`AND assignee_name = ${opts.assignee}` : sql``}
          AND (generating_since IS NULL OR generating_since < now() - make_interval(mins => ${GEN_WINDOW_MIN}))
        ORDER BY source_resolved_at DESC NULLS LAST LIMIT ${limit}`
    ).map((r) => r.id);
    const made: number[] = [];
    let fail = 0, attempted = 0;
    for (const did of ids) {
      if (opts.deadline && opts.deadline - Date.now() < minLeft) break;
      attempted++;
      await sql`UPDATE sb.rm_sb_docs SET generating_since = now() WHERE id = ${did}`;
      const r = await generate(did);
      if (r.ok) made.push(did);
      else fail++;
    }
    // 방금 만든 문서 id 를 돌려준다 — 호출부가 곧바로 담당자에게 알릴 수 있게.
    return { generated: made.length, failed: fail, attempted, generated_ids: made };
  });
  return res ?? { generated: 0, failed: 0, attempted: 0, generated_ids: [] as number[], skipped: true };
}

// ── 알림 메일 ──────────────────────────────────────────────────────────────

/** 담당자에게 검토 요청 메일. 담당자 주소를 못 만들면 관리자에게 보낸다. */
export async function notify(docId: number): Promise<{ sent: boolean; error?: string; to?: string[] }> {
  const { adminEmails, appUrl, sendAsUser, systemSenderUserId } = await import("../mailer");
  const { render } = await import("../mailTemplates");

  const [doc] = await sql<(SbDocRow & { subject: string | null })[]>`
    SELECT d.*, i.subject FROM sb.rm_sb_docs d LEFT JOIN sb.rm_issues i ON i.id = d.issue_id WHERE d.id = ${docId}`;
  if (!doc) return { sent: false, error: "문서를 찾을 수 없습니다." };
  if (doc.state !== "draft") return { sent: false, error: `초안 상태가 아닙니다(state=${doc.state}).` };

  const to = doc.assignee_email ? [doc.assignee_email] : await adminEmails();
  const fallback = !doc.assignee_email;
  if (!to.length) return { sent: false, error: "수신자를 정할 수 없습니다(담당자 주소·관리자 주소 모두 없음)." };

  const uid = await systemSenderUserId();
  if (uid === null) return { sent: false, error: "발송 계정 없음 — [계정 관리]에서 이메일 자격증명을 등록하세요." };

  const url = await issueUrlMaker();
  const subject = doc.subject || "";
  const rows = [
    `■ 이슈       : #${doc.issue_id} ${subject.slice(0, 70)}`,
    `                ${url(doc.issue_id)}`,
    `■ 문서 제목  : ${doc.title}`,
    `■ 추천 등급  : ${doc.disclosure} (${DISCLOSURES[doc.disclosure] ?? ""}) — ${doc.disclosure_reason || ""}`,
    `■ Applies to : ${(doc.applies_to || "").slice(0, 120)}`,
  ];
  if (doc.revision > 1) rows.push(`■ 개정       : ${doc.revision}판 (이슈가 다시 열렸다가 해결되어 새로 작성했습니다)`);
  const assignee = doc.assignee_name || "";
  const [mailSubject, body] = await render("sb_review", {
    담당자: assignee || "담당자",
    이슈번호: doc.issue_id,
    문서제목: (doc.title || "").slice(0, 50),
    정보표: rows.join("\n") + "\n",
    대신보냄: fallback ? `\n※ 담당자(${assignee}) 메일 주소를 규칙으로 만들지 못해 관리자에게 대신 보냅니다.\n` : "",
    화면주소: `${appUrl()}/sb`,
  });
  const { sbReviewHtml } = await import("../mailHtml");
  const { htmlToText } = await import("../kb/text");
  const preview = htmlToText(doc.description_html || "");
  const html = sbReviewHtml({
    assignee, issueId: doc.issue_id, issueSubject: subject, issueUrl: url(doc.issue_id), title: doc.title || "",
    disclosure: doc.disclosure, disclosureKo: DISCLOSURES[doc.disclosure] ?? "", reason: doc.disclosure_reason || "",
    appliesTo: doc.applies_to || "", revision: doc.revision, fallback,
    preview: preview.length > 700 ? preview.slice(0, 700) + " …" : preview,
    docUrl: `${appUrl()}/sb?doc=${doc.id}`,     // SB 문서 화면이 이 문서를 먼저 고른다
  });
  const [ok, err] = await sendAsUser(uid, to, mailSubject, body, { html });
  if (!ok) return { sent: false, error: err, to };

  await sql`UPDATE sb.rm_sb_docs SET state = 'notified', notified_at = now() WHERE id = ${docId}`;
  console.info(`SB 검토 요청 발송: #${doc.issue_id} → ${to.join(", ")}`);
  return { sent: true, to };
}

/** 방금 만든 초안들을 담당자에게 알린다. origin='auto' 만 — 소급분은 사람이 화면에서 보낸다. */
export async function notifyMany(docIds: number[]) {
  if (!docIds.length) return { sent: 0, failed: 0, errors: [] as string[] };
  const auto = new Set(
    (await sql<{ id: number }[]>`SELECT id FROM sb.rm_sb_docs WHERE id = ANY(${docIds}::int[]) AND origin = 'auto'`).map((r) => r.id),
  );
  let sent = 0, failed = 0;
  const errs: string[] = [];
  for (const did of docIds) {
    if (!auto.has(did)) continue;
    const r = await notify(did);
    if (r.sent) sent++;
    else {
      failed++;
      errs.push(String(r.error ?? ""));
    }
  }
  return { sent, failed, errors: errs.slice(0, 3) };
}

/** 알림을 못 보낸 채 남은 자동 생성 초안을 다시 시도한다(재시도 그물). */
export async function notifyPending(limit = 10) {
  const ids = (
    await sql<{ id: number }[]>`
      SELECT id FROM sb.rm_sb_docs WHERE state = 'draft' AND origin = 'auto' ORDER BY generated_at NULLS LAST LIMIT ${limit}`
  ).map((r) => r.id);
  return notifyMany(ids);
}

// ── 사람의 손 ─────────────────────────────────────────────────────────────

export type DraftFields = { title?: string | null; disclosure?: string | null; applies_to?: string | null; description_html?: string | null; partners?: string[] | null };

/** 화면에서 고친 내용을 반영. */
export async function updateDraft(docId: number, f: DraftFields): Promise<{ ok: boolean; error?: string }> {
  const [doc] = await sql<SbDocRow[]>`SELECT * FROM sb.rm_sb_docs WHERE id = ${docId}`;
  if (!doc) return { ok: false, error: "문서를 찾을 수 없습니다." };
  if (doc.state === "approved") return { ok: false, error: "확정된 문서는 고칠 수 없습니다. 먼저 확정을 취소하세요." };
  const title = f.title ?? doc.title;
  let disclosure = f.disclosure ?? doc.disclosure;
  if (!(disclosure in DISCLOSURES)) disclosure = "internal";
  const applies = f.applies_to ?? doc.applies_to;
  let html = f.description_html ?? doc.description_html;
  if (html) html = sanitizeHtml(html);
  const partners = f.partners !== undefined ? JSON.stringify(f.partners || []) : doc.partners_json;
  await sql`
    UPDATE sb.rm_sb_docs SET title = ${title}, disclosure = ${disclosure}, applies_to = ${applies},
      description_html = ${html}, partners_json = ${partners}, is_troubleshooting = ${(title || "").startsWith("[TR]")}
    WHERE id = ${docId}`;
  return { ok: true };
}

/** 담당자가 내용을 확정한다. 확정된 문서는 고칠 수 없고, 되돌리면 다시 초안이 된다. */
export async function approve(docId: number, by = ""): Promise<{ ok: boolean; error?: string }> {
  const [doc] = await sql<SbDocRow[]>`SELECT * FROM sb.rm_sb_docs WHERE id = ${docId}`;
  if (!doc) return { ok: false, error: "문서를 찾을 수 없습니다." };
  if (!["draft", "notified"].includes(doc.state)) return { ok: false, error: `확정할 수 있는 상태가 아닙니다(state=${doc.state}).` };
  if (!(doc.title || "").trim()) return { ok: false, error: "제목이 비어 있습니다." };
  await sql`UPDATE sb.rm_sb_docs SET state = 'approved', decided_at = now(), decided_by = ${by || null} WHERE id = ${docId}`;
  await publishSbDoc(docId);           // 확정한 문서는 곧바로 FAQ 에 올라간다
  return { ok: true };
}

/** 쓰지 않기로 결정. 초안은 이력으로 남긴다(지우지 않는다). */
export async function discard(docId: number, by = "", reason = ""): Promise<{ ok: boolean; error?: string }> {
  const [doc] = await sql<SbDocRow[]>`SELECT * FROM sb.rm_sb_docs WHERE id = ${docId}`;
  if (!doc) return { ok: false, error: "문서를 찾을 수 없습니다." };
  if (doc.state === "approved") return { ok: false, error: "확정된 문서입니다. 먼저 확정을 취소하세요." };
  await sql`
    UPDATE sb.rm_sb_docs SET state = 'discarded', decided_at = now(), decided_by = ${by || null},
      error = ${reason ? `폐기 사유: ${reason}`.slice(0, 2000) : doc.error}
    WHERE id = ${docId}`;
  return { ok: true };
}

/** 폐기했거나 확정한 문서를 다시 검토 대상(초안)으로 되돌린다. */
export async function reopenDraft(docId: number): Promise<{ ok: boolean; error?: string }> {
  const [doc] = await sql<SbDocRow[]>`SELECT * FROM sb.rm_sb_docs WHERE id = ${docId}`;
  if (!doc || !["discarded", "approved"].includes(doc.state)) return { ok: false, error: "폐기되거나 확정된 문서가 아닙니다." };
  await sql`
    UPDATE sb.rm_sb_docs SET state = ${doc.generated_at ? "draft" : "backlog"}, decided_at = NULL, decided_by = NULL
    WHERE id = ${docId}`;
  if (doc.state === "approved") await unpublishSbDoc(docId);    // 확정 취소 → FAQ 에서 내린다
  return { ok: true };
}

// ── 요약 ────────────────────────────────────────────────────────────────────

/** 검토를 맡을 담당자인데 앱 계정이 없는 사람 — 메일을 받아도 로그인할 수 없다. */
export async function assigneesWithoutAccount(): Promise<{ name: string; count: number }[]> {
  try {
    const rows = await sql<{ name: string; count: number }[]>`
      SELECT d.assignee_name AS name, count(*)::int8 AS count
      FROM sb.rm_sb_docs d
      WHERE NOT d.superseded AND d.state IN ('queued', 'draft', 'notified') AND d.assignee_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sb.users u WHERE u.username = d.assignee_name)
      GROUP BY d.assignee_name ORDER BY count(*) DESC`;
    return rows.map((r) => ({ name: r.name, count: r.count }));
  } catch {
    return [];
  }
}

/** 상태별 건수 · 쓴 비용. assignee 를 주면 그 담당자 문서만(화면 범위와 맞춘다). */
export async function summary(assignee = "") {
  const scope = assignee ? sql`AND assignee_name = ${assignee}` : sql``;
  const counts = Object.fromEntries(
    (await sql<{ state: string; n: number }[]>`
      SELECT state, count(*)::int8 AS n FROM sb.rm_sb_docs WHERE NOT superseded ${scope} GROUP BY state`).map((r) => [r.state, r.n]),
  ) as Record<string, number>;
  const tok = await sql<{ model: string | null; i: number; o: number }[]>`
    SELECT model, COALESCE(sum(input_tokens), 0)::int8 AS i, COALESCE(sum(output_tokens), 0)::int8 AS o
    FROM sb.rm_sb_docs WHERE NOT superseded ${scope} GROUP BY model`;
  let spent = 0;
  for (const t of tok) {
    const [pin, pout] = price(t.model || "claude-opus-5");
    spent += (t.i / 1e6) * pin + (t.o / 1e6) * pout;
  }
  const [gen] = await sql`
    SELECT 1 FROM sb.rm_sb_docs WHERE generating_since > now() - make_interval(mins => ${GEN_WINDOW_MIN}) LIMIT 1`;
  return {
    counts,
    backlog: counts.backlog ?? 0,
    queued: counts.queued ?? 0,
    draft: counts.draft ?? 0,
    notified: counts.notified ?? 0,
    error: counts.error ?? 0,
    spent_usd: Math.round(spent * 1000) / 1000,
    watermark: await getState(K_WATERMARK),
    running: Boolean(gen) || (await isLocked(GEN_LOCK)),
  };
}
