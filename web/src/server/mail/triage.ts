/**
 * 메일 스레드 가리기 — 조용해진 스레드(새 메일이 QUIET_DAYS 동안 없음)를 Claude(Haiku)가 읽고
 * FAQ 로 남길 만한 기술 문의인지 정한다. 감이면 업로드 문서(rm_sb_docs, source='mail')를 queued 로 만든다.
 * 초안 본문은 SB 생성(sb.ts generate)이 Redmine 과 같은 흐름으로 쓴다.
 *
 * 우리 쪽(@pointmobile.com) 답장이 하나도 없는 스레드는 Claude 를 부르지 않고 건너뛴다(광고 · 스팸 · 참조만 된 메일).
 */
import { z } from "zod";
import { parseStructured } from "../claude";
import { sql } from "../db";
import { assigneeEmail } from "../issuetrack/sb";
import { threadText } from "./store";

export const QUIET_DAYS = 3;
const TRIAGE_MODEL = process.env.MAIL_TRIAGE_MODEL || "claude-haiku-5-5";

const Triage = z.object({
  category: z.enum(["tech_support", "service_request", "dev_request", "sales", "internal", "other"]).describe(
    "tech_support=제품 기술 문의 · 장애 분석 · 설정 방법, service_request=FOTA 등록 · 계정 발급 · 매뉴얼/파일 요청 같은 처리 요청, " +
      "dev_request=커스텀 OS · 기능 개발 의뢰, sales=견적 · RFP · 영업, internal=사내 업무, other=그 밖(광고 · 알림 등)"),
  has_resolution: z.boolean().describe("원인 · 해결 방법 · 답이 스레드 안에 실제로 적혀 있는가"),
  faq_value: z.enum(["high", "medium", "low", "none"]).describe("같은 문제를 겪는 다른 사람에게 참고가 될 정도"),
  reason: z.string().describe("판단 이유 한국어 한 문장"),
});

export const TRIAGE_SYSTEM = `포인트모바일(산업용 PDA · 바코드 스캐너 제조사) TA(기술지원)팀 받은 메일함의 스레드를 가린다.
목적: 처리가 끝난 기술 문의를 사내 FAQ 로 남길지 정한다.
- 처리 요청(FOTA 등록, 계정 발급 등)은 계정 · 시리얼 · 연락처가 섞여 있어 FAQ 로 쓰지 않는다 → service_request.
- 홈페이지 문의에 '구매처(파트너)로 문의하라'는 정형 답만 한 것은 faq_value=none.
- 답이 없거나 아직 진행 중이면 has_resolution=false.`;

/** 조용해진 스레드를 limit 건까지 가린다. */
export async function triagePending(opts: { limit?: number; deadline?: number } = {}) {
  const rows = await sql<{ id: number; n_messages: number; handler: string }[]>`
    SELECT id, n_messages, handler FROM sb.mail_threads
    WHERE state = 'open' AND noise = '' AND last_at < now() - make_interval(days => ${QUIET_DAYS})
    ORDER BY last_at LIMIT ${opts.limit ?? 10}`;
  let candidates = 0, skipped = 0, failed = 0;
  for (const t of rows) {
    if (opts.deadline && opts.deadline - Date.now() < 30_000) break;
    const [ours] = await sql`
      SELECT 1 FROM sb.mail_messages WHERE thread_id = ${t.id} AND noise = '' AND from_addr LIKE '%@pointmobile.com' LIMIT 1`;
    if (!ours) {
      await mark(t.id, "skipped", "other", "포인트모바일 쪽 답장이 없는 스레드", t.n_messages);
      skipped++;
      continue;
    }
    const res = await parseStructured({
      system: TRIAGE_SYSTEM,
      prompt: await threadText(t.id, 30000),
      schema: Triage,
      operation: "메일 스레드 가리기",
      maxTokens: 1500,
      model: TRIAGE_MODEL,
    });
    if (!res.ok) {
      failed++;
      console.warn(`[mail] 스레드 ${t.id} 가리기 실패: ${res.error}`);
      continue;
    }
    const d = res.data;
    const keep = ["tech_support", "dev_request"].includes(d.category) && d.has_resolution && ["high", "medium"].includes(d.faq_value);
    if (keep) {
      await makeDoc(t.id, t.handler, "queued", "auto");
      candidates++;
    } else skipped++;
    await mark(t.id, keep ? "candidate" : "skipped", d.category, `${d.faq_value}${d.has_resolution ? "" : " · 미해결"} — ${d.reason}`, t.n_messages);
  }
  return { triaged: candidates + skipped, candidates, skipped, failed };
}

export async function mark(threadId: number, state: string, category: string, reason: string, n: number) {
  await sql`
    UPDATE sb.mail_threads SET state = ${state}, category = ${category}, triage_reason = ${reason.slice(0, 1000)},
      triaged_at = now(), triaged_n = ${n}
    WHERE id = ${threadId}`;
}

/** 스레드로 업로드 문서 행을 만든다(이미 있으면 그 id). 담당자 = 스레드에서 답장한 사내 계정. */
export async function makeDoc(threadId: number, handler: string, state: string, origin: string): Promise<number> {
  const [prev] = await sql<{ id: number }[]>`
    SELECT id FROM sb.rm_sb_docs WHERE mail_thread_id = ${threadId} AND NOT superseded ORDER BY revision DESC LIMIT 1`;
  if (prev) return prev.id;
  const [t] = await sql<{ last_at: Date | null }[]>`SELECT last_at FROM sb.mail_threads WHERE id = ${threadId}`;
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO sb.rm_sb_docs (issue_id, source, mail_thread_id, revision, state, origin, source_resolved_at, assignee_name, assignee_email, created_at)
    VALUES (NULL, 'mail', ${threadId}, 1, ${state}, ${origin}, ${t?.last_at ?? null}, ${handler || null}, ${assigneeEmail(handler)}, now())
    RETURNING id`;
  return r.id;
}
