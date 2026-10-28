/**
 * 받은 메일함 수집 — 시스템 메일 계정의 INBOX 를 IMAP 으로 **읽기만** 한다.
 *   · 메일함은 읽기 전용(EXAMINE)으로 열고, 본문은 BODY.PEEK 로 받는다 — 읽음 표시 · 폴더 · 삭제 모두 건드리지 않는다.
 *   · UID 순으로 지난번 다음부터 이어 받는다(rm_sync_state 'mail_uid'). UIDVALIDITY 가 바뀌면 처음부터 —
 *     같은 Message-ID 는 다시 넣지 않으므로 안전하다.
 *   · 메일 서버는 2주 남짓만 보관한다. 5분마다 돌면 놓치지 않는다.
 * 한 통이 아주 크면(첨부) 앞 2MB 만 받는다 — 본문은 앞에 오고, 첨부는 이름만 쓴다.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { sql } from "../db";
import { inboxIdentity, systemFrom } from "../mailer";
import { filesOf, uploadPending } from "./attachments";
import { saveMail } from "./store";

const K_UID = "mail_uid";               // "<uidvalidity>:<마지막 uid>"
const BATCH = 60;
const MAX_SOURCE = 2 * 1024 * 1024;

async function getState(key: string): Promise<string | null> {
  const [r] = await sql<{ value: string | null }[]>`SELECT value FROM sb.rm_sync_state WHERE key = ${key}`;
  return r?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO sb.rm_sync_state (key, value, updated_at) VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

const addrs = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => v.address || "")).filter(Boolean).join(", ");

export type IngestResult = {
  fetched: number; saved: number; last_uid: number; more: boolean; error?: string;
  files?: { uploaded: number; failed: number };
};

/** 새 메일을 받아 스레드에 넣는다. deadline 전에 멈추고, 남은 것은 다음 주기에. */
export async function ingestInbox(deadline: number): Promise<IngestResult> {
  const id = await inboxIdentity();
  if (!id) return { fetched: 0, saved: 0, last_uid: 0, more: false, error: "받은 메일함 계정 없음 — 시스템 메일 계정의 자격증명을 등록하세요" };
  const own = [id.email, systemFrom()[0]].filter(Boolean);

  const client = new ImapFlow({
    host: id.host, port: 993, secure: true, auth: { user: id.email, pass: id.password },
    logger: false, socketTimeout: 60_000,
  });
  await client.connect();
  let fetched = 0, saved = 0, last = 0, more = false;
  let files = { uploaded: 0, failed: 0 };
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mb = client.mailbox;
      const validity = mb && typeof mb === "object" ? String(mb.uidValidity) : "0";
      const [v, u] = (await getState(K_UID) || "").split(":");
      last = v === validity ? Number(u) || 0 : 0;

      const uids = ((await client.search({ uid: `${last + 1}:*` }, { uid: true })) || []).filter((x) => x > last).sort((a, b) => a - b);
      const take = uids.slice(0, BATCH);
      more = uids.length > take.length;
      if (take.length) {
        for await (const msg of client.fetch(take.join(","), { uid: true, bodyStructure: true, source: { maxLength: MAX_SOURCE } }, { uid: true })) {
          if (Date.now() > deadline) { more = true; break; }
          fetched++;
          try {
            const p = await simpleParser(msg.source ?? Buffer.alloc(0), { skipImageLinks: true, skipTextToHtml: true });
            const from = p.from?.value?.[0];
            const refs = Array.isArray(p.references) ? p.references.join(" ") : p.references || "";
            const r = await saveMail({
              messageId: p.messageId || `<uid-${validity}-${msg.uid}@inbox>`,
              inReplyTo: p.inReplyTo || "",
              refs,
              uid: msg.uid,
              from: from?.address || "",
              fromName: from?.name || "",
              to: addrs(p.to),
              cc: addrs(p.cc),
              subject: p.subject || "",
              sentAt: p.date ?? null,
              text: p.text || "",
              attachments: (p.attachments || []).filter((a) => a.contentDisposition !== "inline").map((a) => a.filename || "").filter(Boolean),
              files: filesOf(msg.bodyStructure),
            }, own);
            if (r !== null) saved++;
          } catch (e) {
            console.warn(`[mail] uid ${msg.uid} 해석 실패: ${e instanceof Error ? e.message : e}`);
          }
          last = Math.max(last, msg.uid);
        }
        await setState(K_UID, `${validity}:${last}`);
      }
      // 업로드 문서가 된 스레드의 첨부를 같은 연결로 받아 Dropbox 에 올린다
      files = await uploadPending(client, deadline);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { fetched, saved, last_uid: last, more, files };
}
