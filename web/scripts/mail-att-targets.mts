/**
 * 첨부 소급 1단계 — 업로드 문서가 된 메일 스레드의 메일 목록(id · Message-ID)을 JSON 으로 쓴다. 읽기 전용.
 *   node --env-file=.env.local --import tsx scripts/mail-att-targets.mts <출력.json>
 */
import { writeFileSync } from "node:fs";
import { sql } from "../src/server/db.ts";

const rows = await sql<{ id: number; mid: string; thread_id: number; uid: number | null }[]>`
  SELECT m.id, m.message_id AS mid, m.thread_id, m.imap_uid AS uid FROM sb.mail_messages m
  WHERE m.noise = '' AND EXISTS (SELECT 1 FROM sb.rm_sb_docs d WHERE d.mail_thread_id = m.thread_id AND d.source = 'mail' AND NOT d.superseded)
    AND NOT EXISTS (SELECT 1 FROM sb.mail_attachments a WHERE a.message_id = m.id)
  ORDER BY m.id`;
writeFileSync(process.argv[2], JSON.stringify(rows));
console.log(`대상 메일 ${rows.length}통 (스레드 ${new Set(rows.map((r) => r.thread_id)).size}개)`);
await sql.end();
