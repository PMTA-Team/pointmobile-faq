import { redirect } from "next/navigation";

/**
 * 홈 — FAQ 가 기본 화면이다. SB 문서는 /sb 로 옮겼다.
 * 예전 검토 요청 메일의 링크(/?doc=<id>)는 그 SB 문서로 보낸다.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const doc = (await searchParams).doc;
  const id = Number(Array.isArray(doc) ? doc[0] : doc);
  redirect(Number.isFinite(id) && id > 0 ? `/sb?doc=${id}` : "/faq");
}
