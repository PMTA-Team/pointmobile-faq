/**
 * FAQ 첨부를 Dropbox(/TA FAQ/attachments/<문서 id>/<파일명>)로 올린다. 올린 것은 storage_path 를 채운다(다시 돌리면 남은 것만).
 *   내용: DB(sb.kb_files)에 있으면 그것, 없으면 원본 Confluence 에서 받는다(SOURCE_DATABASE_URL 의 Confluence 계정).
 *   DATABASE_URL · SOURCE_DATABASE_URL · FERNET_KEY 가 필요하다.
 */
import postgres from "postgres";
import { decryptSecret } from "../src/server/crypto.ts";
import { sql } from "../src/server/db.ts";
import { attachmentPath, upload } from "../src/server/dropbox.ts";

const src = postgres(process.env.SOURCE_DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const [c] = await src`SELECT username, encrypted_password FROM public.web_credentials WHERE target = 'release_notes'`;
await src.end();
const conf = "Basic " + Buffer.from(`${c.username}:${decryptSecret(c.encrypted_password)}`).toString("base64");

const todo = await sql<{ id: number; article_id: number; filename: string; size: number; source_url: string | null; in_db: boolean }[]>`
  SELECT a.id, a.article_id, a.filename, a.size, a.source_url,
         EXISTS (SELECT 1 FROM sb.kb_files f WHERE f.attachment_id = a.id) AS in_db
  FROM sb.kb_attachments a WHERE a.storage_path IS NULL ORDER BY a.size
  LIMIT ${Number(process.argv[2]) || 100000}`;   // 인자로 개수를 주면 그만큼만(시험용)
const total = todo.reduce((n, a) => n + Number(a.size), 0);
console.log(`올릴 첨부 ${todo.length}개 · ${(total / 1048576).toFixed(0)}MB`);

let done = 0, failed = 0, bytes = 0;
const fails: string[] = [];
async function worker(queue: typeof todo) {
  for (let a = queue.shift(); a; a = queue.shift()) {
    try {
      let data: Uint8Array;
      if (a.in_db) {
        const [f] = await sql<{ data: Buffer }[]>`SELECT data FROM sb.kb_files WHERE attachment_id = ${a.id}`;
        data = new Uint8Array(f.data);
      } else {
        if (!a.source_url) throw new Error("원본 주소 없음");
        const r = await fetch(a.source_url, { headers: { Authorization: conf }, signal: AbortSignal.timeout(600_000) });
        if (!r.ok) throw new Error(`Confluence HTTP ${r.status}`);
        data = new Uint8Array(await r.arrayBuffer());
      }
      const path = await attachmentPath(a.article_id, a.filename);
      await upload(path, data);
      await sql`UPDATE sb.kb_attachments SET storage_path = ${path}, link_cache = NULL, link_expires = NULL WHERE id = ${a.id}`;
      done++; bytes += data.length;
    } catch (e) {
      failed++;
      if (fails.length < 15) fails.push(`${a.id} ${a.filename}: ${(e as Error).message.slice(0, 160)}`);
    }
    if ((done + failed) % 50 === 0) process.stdout.write(`\r${done + failed}/${todo.length} (${(bytes / 1048576).toFixed(0)}MB, 실패 ${failed})`);
  }
}
const queue = [...todo];
await Promise.all(Array.from({ length: 4 }, () => worker(queue)));
console.log(`\n올림 ${done} (${(bytes / 1048576).toFixed(1)}MB) · 실패 ${failed}`);
if (fails.length) console.log(fails.join("\n"));
await sql.end();
