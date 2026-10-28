/**
 * 메일 한 통을 스레드에 넣는다 — 실시간 수집(imap.ts)과 소급 이관(scripts)이 함께 쓴다.
 *
 * 묶는 순서: ① References · In-Reply-To 에 있는 메일이 이미 있으면 그 스레드 ② 없으면 같은 제목 키로
 * 최근 60일 안에 오간 스레드 ③ 그래도 없으면 새 스레드. Message-ID 가 같으면 다시 넣지 않는다(중복 수집 안전).
 */
import { sql } from "../db";
import { assigneeSet, loadSbSettings } from "../issuetrack/settings";
import { cleanBody, isReplySubject, noiseOf, staffName, subjectKey } from "./rules";

export type MailIn = {
  messageId: string;
  inReplyTo?: string;
  refs?: string;
  uid?: number | null;
  from: string;
  fromName?: string;
  to?: string;
  cc?: string;
  subject: string;
  sentAt: Date | null;
  text: string;
  attachments?: string[];
};

const SAME_SUBJECT_DAYS = 60;

const ids = (s: string | undefined) => (s || "").match(/<[^<>\s]+>/g) ?? [];

/** 넣었으면 스레드 id, 이미 있던 메일이면 null. own = 앱이 보내는 주소들(앱 알림은 잡음). */
export async function saveMail(m: MailIn, own: string[] = []): Promise<number | null> {
  const messageId = (m.messageId || "").trim().slice(0, 500);
  if (!messageId) return null;
  const [dup] = await sql`SELECT 1 FROM sb.mail_messages WHERE message_id = ${messageId}`;
  if (dup) return null;

  const from = (m.from || "").trim().toLowerCase();
  const finalNoise = noiseOf({ from, subject: m.subject }, own);
  const key = subjectKey(m.subject);
  const linked = [...ids(m.refs), ...ids(m.inReplyTo)];

  let threadId: number | null = null;
  if (linked.length) {
    const [r] = await sql<{ thread_id: number }[]>`
      SELECT thread_id FROM sb.mail_messages WHERE message_id = ANY(${linked}::text[]) ORDER BY id LIMIT 1`;
    threadId = r?.thread_id ?? null;
  }
  // 제목으로 묶는 것은 답장 · 전달일 때만 — 새 메일은 제목이 같아도 새 스레드다
  // (홈페이지 '온라인문의'처럼 제목이 늘 같은 메일이 한데 엉키지 않게).
  if (threadId === null && key && (linked.length || isReplySubject(m.subject))) {
    const at = m.sentAt ?? new Date();
    const [r] = await sql<{ id: number }[]>`
      SELECT id FROM sb.mail_threads
      WHERE subject_key = ${key} AND last_at > ${at}::timestamptz - make_interval(days => ${SAME_SUBJECT_DAYS})
        AND first_at < ${at}::timestamptz + make_interval(days => ${SAME_SUBJECT_DAYS})
      ORDER BY last_at DESC LIMIT 1`;
    threadId = r?.id ?? null;
  }
  if (threadId === null) {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO sb.mail_threads (subject, subject_key, first_at, last_at, noise, state)
      VALUES (${m.subject || ""}, ${key}, ${m.sentAt}, ${m.sentAt}, ${finalNoise}, ${finalNoise ? "noise" : "open"})
      RETURNING id`;
    threadId = r.id;
  }

  const body = finalNoise ? null : cleanBody(m.text).slice(0, 20000);
  const inserted = await sql`
    INSERT INTO sb.mail_messages (thread_id, message_id, in_reply_to, refs, imap_uid, from_addr, from_name, to_addrs, cc_addrs,
      subject, sent_at, body_text, attachments, noise)
    VALUES (${threadId}, ${messageId}, ${(m.inReplyTo || "").slice(0, 500)}, ${(m.refs || "").slice(0, 8000)}, ${m.uid ?? null},
      ${from.slice(0, 300)}, ${(m.fromName || "").slice(0, 300)}, ${(m.to || "").slice(0, 4000)}, ${(m.cc || "").slice(0, 4000)},
      ${m.subject || ""}, ${m.sentAt}, ${body}, ${(m.attachments || []).map((a) => a.slice(0, 300))}, ${finalNoise})
    ON CONFLICT (message_id) DO NOTHING RETURNING id`;
  if (!inserted.length) return null;
  await refreshThread(threadId);
  return threadId;
}

/**
 * 스레드 요약 칸을 메일들로 다시 계산한다. 메일이 하나라도 사람이 볼 메일이면 스레드도 잡음이 아니다.
 * 이미 가린 스레드(skipped)에 새 메일이 오면 다시 가리도록 open 으로 돌린다. candidate 는 문서가 있으므로 그대로 둔다.
 */
export async function refreshThread(threadId: number): Promise<void> {
  const msgs = await sql<{ from_addr: string; noise: string; sent_at: Date | null }[]>`
    SELECT from_addr, noise, sent_at FROM sb.mail_messages WHERE thread_id = ${threadId} ORDER BY sent_at NULLS FIRST, id`;
  if (!msgs.length) return;
  const human = msgs.filter((x) => !x.noise);
  const noise = human.length ? "" : msgs[0].noise;
  const count = new Map<string, number>();
  for (const x of human) {
    const n = staffName(x.from_addr);
    if (n) count.set(n, (count.get(n) ?? 0) + 1);
  }
  // 담당 = 답장한 TA 담당자([설정 → SB 동작]의 담당자 목록) 중 가장 많이 쓴 사람. TA 가 없으면 가장 많이 쓴 사내 계정
  // (영업 · 운영 쪽이 문의를 전달한 메일이 많아, 그냥 많이 쓴 사람으로 정하면 전달한 사람이 담당이 된다).
  const ta = assigneeSet(await loadSbSettings());
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  const handler = (ranked.find(([n]) => ta.has(n)) ?? ranked[0])?.[0] ?? "";
  const times = msgs.map((x) => x.sent_at).filter((t): t is Date => Boolean(t)).map((t) => t.getTime());
  await sql`
    UPDATE sb.mail_threads SET
      n_messages = ${msgs.length}, noise = ${noise},
      first_at = ${times.length ? new Date(Math.min(...times)) : null},
      last_at = ${times.length ? new Date(Math.max(...times)) : null},
      handler = ${handler},
      state = CASE
        WHEN ${noise} <> '' THEN 'noise'
        WHEN state = 'noise' THEN 'open'
        WHEN state = 'skipped' AND ${msgs.length} > triaged_n THEN 'open'
        ELSE state END
    WHERE id = ${threadId}`;
}

/** 스레드를 Claude 에게 넘길 평문으로(사람이 주고받은 메일만, 오래된 것부터). */
export async function threadText(threadId: number, maxTotal = 60000): Promise<string> {
  const [t] = await sql<{ subject: string; n_messages: number }[]>`SELECT subject, n_messages FROM sb.mail_threads WHERE id = ${threadId}`;
  if (!t) return "";
  const msgs = await sql<{ from_addr: string; from_name: string; to_addrs: string; sent_at: Date | null; subject: string; body_text: string | null; attachments: string[] }[]>`
    SELECT from_addr, from_name, to_addrs, sent_at, subject, body_text, attachments FROM sb.mail_messages
    WHERE thread_id = ${threadId} AND noise = '' ORDER BY sent_at NULLS FIRST, id`;
  const parts = [`[메일 스레드] ${t.subject} (메일 ${msgs.length}통)`];
  for (const [i, m] of msgs.entries()) {
    const side = /@pointmobile\.com$/i.test(m.from_addr) ? "포인트모바일" : `외부(${m.from_addr.split("@")[1] || "?"})`;
    parts.push(
      `\n### 메일 ${i + 1} — ${m.sent_at ? m.sent_at.toISOString().slice(0, 16).replace("T", " ") : "?"} · ${side} · ${m.from_name || m.from_addr}` +
        (m.attachments?.length ? `\n첨부: ${m.attachments.join(", ")}` : "") +
        `\n${(m.body_text || "").slice(0, 6000)}`,
    );
  }
  let text = parts.join("\n");
  if (text.length > maxTotal) text = text.slice(0, maxTotal / 2) + "\n\n…(중략)…\n\n" + text.slice(-(maxTotal / 2));
  return text;
}
