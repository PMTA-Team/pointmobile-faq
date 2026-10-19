/**
 * 사내 인원 명부(sb.staff, 예전 시스템에서 옮겨 온 것) — 읽기만 한다.
 * 메일을 보낼 때 받는 사람의 주소 · 이름을 찾는 데 쓴다(mailer.ts).
 */
import { sql } from "./db";

const ACTIVE = "재직";

export type StaffRow = { id: number; name: string; email: string; status: string; team: string; memo: string; updated_by: string };

/** 명부 전체. 재직 먼저, 그다음 이름순. */
export async function listStaff(): Promise<StaffRow[]> {
  const rows = await sql<StaffRow[]>`SELECT id, name, email, status, team, memo, updated_by FROM sb.staff`;
  const out = rows.map((s) => ({
    id: s.id, name: s.name || "", email: s.email || "", status: s.status || ACTIVE,
    team: s.team || "", memo: s.memo || "", updated_by: s.updated_by || "",
  }));
  out.sort((a, b) => {
    const la = a.status !== ACTIVE ? 1 : 0, lb = b.status !== ACTIVE ? 1 : 0;
    if (la !== lb) return la - lb;
    const ka = a.name || a.email, kb = b.name || b.email;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}
