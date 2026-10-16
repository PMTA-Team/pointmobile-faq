/**
 * tw-automation-v2 의 Dropbox 자격증명(회사 지원팀 계정)을 이 앱 DB(sb.dropbox_credentials)로 옮긴다.
 * 두 앱이 같은 FERNET_KEY 를 써서 암호문을 그대로 옮긴다 — 원문은 다루지 않는다.
 *   V2_DATABASE_URL=… DATABASE_URL=… node --import tsx scripts/copy-dropbox-cred.mts
 */
import postgres from "postgres";

const src = postgres(process.env.V2_DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const dst = postgres(process.env.DATABASE_URL!, { prepare: false, onnotice: () => {}, max: 1 });
const [c] = await src`
  SELECT d.encrypted_app_key, d.encrypted_app_secret, d.encrypted_refresh_token FROM dropbox_credentials d
  JOIN users u ON u.id = d.user_id WHERE d.encrypted_refresh_token <> '' ORDER BY (u.username = 'admin') DESC, d.id LIMIT 1`;
if (!c) throw new Error("tw-automation-v2 에 Dropbox refresh 자격증명이 없습니다");
await dst`
  INSERT INTO sb.dropbox_credentials (id, encrypted_app_key, encrypted_app_secret, encrypted_refresh_token, updated_at)
  VALUES (1, ${c.encrypted_app_key}, ${c.encrypted_app_secret}, ${c.encrypted_refresh_token}, now())
  ON CONFLICT (id) DO UPDATE SET encrypted_app_key = EXCLUDED.encrypted_app_key, encrypted_app_secret = EXCLUDED.encrypted_app_secret,
    encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, updated_at = now()`;
console.log("Dropbox 자격증명을 옮겼습니다(root /TA FAQ)");
await src.end();
await dst.end();
