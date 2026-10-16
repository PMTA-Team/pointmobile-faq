/**
 * 이관한 문서의 이미지 첨부를 Confluence 에서 받아 sb.kb_files 에 넣는다(이미 받은 것은 건너뛴다 — 다시 돌려도 된다).
 *   DATABASE_URL(대상) · SOURCE_DATABASE_URL(예전 sbnext — Confluence 계정이 암호화돼 있다) · FERNET_KEY 가 필요하다.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { decryptSecret } from "../src/server/crypto.ts";

const dst = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 4 });
const src = postgres(process.env.SOURCE_DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const [c] = await src`SELECT username, encrypted_password FROM public.web_credentials WHERE target = 'release_notes'`;
await src.end();
const auth = "Basic " + Buffer.from(`${c.username}:${decryptSecret(c.encrypted_password)}`).toString("base64");

const todo = await dst<{ id: number; source_url: string; size: number }[]>`
  SELECT a.id, a.source_url, a.size FROM sb.kb_attachments a
  WHERE a.is_image AND NOT EXISTS (SELECT 1 FROM sb.kb_files f WHERE f.attachment_id = a.id) ORDER BY a.id`;
console.log(`받을 이미지 ${todo.length}개`);

let done = 0, failed = 0, bytes = 0;
const fails: string[] = [];
async function worker(queue: typeof todo) {
  for (let a = queue.shift(); a; a = queue.shift()) {
    try {
      const r = await fetch(a.source_url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = createHash("sha256").update(buf).digest("hex");
      await dst`INSERT INTO sb.kb_files (attachment_id, data, sha256) VALUES (${a.id}, ${buf}, ${sha})
                ON CONFLICT (attachment_id) DO NOTHING`;
      done++; bytes += buf.length;
    } catch (e) {
      failed++;
      if (fails.length < 10) fails.push(`${a.id} ${(e as Error).message}`);
    }
    if ((done + failed) % 100 === 0) process.stdout.write(`\r${done + failed}/${todo.length} (${(bytes / 1048576).toFixed(0)}MB, 실패 ${failed})`);
  }
}
const queue = [...todo];
await Promise.all(Array.from({ length: 6 }, () => worker(queue)));
console.log(`\n받음 ${done} (${(bytes / 1048576).toFixed(1)}MB) · 실패 ${failed}`);
if (fails.length) console.log("실패 예:", fails);
await dst.end();
