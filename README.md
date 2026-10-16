# Solution Buffer (pointmobile-faq)

Redmine salesissue 를 수집하고, Resolved 된 이슈를 고객용 문서(SB) 초안으로 만들어 담당자가 검토 · 확정하는 앱.
확정된 문서는 DB(`sb.rm_sb_docs`, state=`approved`)에 남는다.

**Next.js 하나로 된 앱이다** — 화면과 API(`web/src/app/api/**/route.ts`)가 한 프로젝트에 있고 따로 띄우는 백엔드가 없다.
웹(Vercel) + Supabase(PostgreSQL)에 올리는 것을 전제로 짰다. 2026-10-15 에 FastAPI(Python) 백엔드를 옮겨 왔다.

| | 위치 |
|---|---|
| 화면 | `web/src/app/(main)` · `login` · `signup` — Next.js 15 · React 19 · Tailwind 4 |
| API | `web/src/app/api/**/route.ts` — 예전 FastAPI 와 주소 · 요청 · 응답 모양이 같다 |
| 서버 로직 | `web/src/server/` — DB · 세션 · 메일 · Claude · 검증 모드, `server/issuetrack/` — Redmine 수집 · SB 문서 · 통계 |
| DB | PostgreSQL 의 `sb` 스키마 — `web/db/schema.sql` |
| 주기 작업 | `GET /api/cron/tick` — 5분마다 Redmine 수집 → SB 초안 → 검토 요청 메일(Supabase Cron 이 부른다) |

## 웹에 올리기(Vercel + Supabase)

1. **Supabase** 프로젝트를 만들고 스키마를 넣는다.
   `web/.env.local` 의 `DATABASE_URL` 을 Supabase 의 **풀러** 주소로 두고 `npm run db:schema`.
   - 직접 연결(`db.<ref>.supabase.co`)은 IPv6 전용이라 이 PC · Vercel 에서 붙지 않는다. 풀러(IPv4)를 쓴다 —
     `postgresql://postgres.<ref>:<비밀번호>@aws-0-ap-northeast-2.pooler.supabase.com:<포트>/postgres`
     (Vercel 은 **6543**(transaction), 이관처럼 오래 걸리는 작업은 **5432**(session)).
   - 표는 `sb` 스키마에 있어 Supabase Data API(anon 키)로는 열리지 않는다 — 앱은 서버에서 `DATABASE_URL` 로만 붙는다.
2. **데이터 옮기기**(한 번): `SOURCE_DATABASE_URL`(예전 sbnext) 을 넣고 `npm run db:migrate` 로 건수를 본 뒤
   `npm run db:migrate -- --load`. 대상 `sb` 표를 비우고 채운다. `npm run db:check` 로 자격증명이 풀리는지 확인한다.
3. **Vercel** 프로젝트(pmta-team/pointmobile-faq) — Settings → Build and Deployment 에서
   **Root Directory 를 `web`** 으로(비워 두면 저장소 맨 위에 앱이 없어 모든 주소가 404), Framework Preset 은 Next.js.
   환경변수는 `web/.env.example` 을 보고 넣는다(.env 내용을 통째로 붙여 넣으면 한 번에 들어간다).
   - `FERNET_KEY` 는 예전 앱과 **같은 값**이어야 옮겨 온 Redmine · 메일 비밀번호가 풀린다.
   - `DATABASE_URL` 은 풀러 6543 주소.
4. **주기 작업** — Vercel Hobby 는 cron 이 하루 1번이라 **Supabase Cron 이 5분마다 부른다**:
   `APP_URL=https://pointmobile-faq.vercel.app npm run db:cron` (DATABASE_URL · CRON_SECRET 은 Supabase · Vercel 과 같은 값).
   `Authorization: Bearer <CRON_SECRET>` 로 `/api/cron/tick` 을 부르고, 겹쳐 불려도 DB 잠금으로 한 번만 돈다.
   끄기: `SELECT cron.unschedule('sb-tick');`
5. **Redmine 이 사외망에서 열리는지** 먼저 확인한다 — `issue.pointmobile.co.kr` 의 REST API(.json)에 Vercel 서버가 닿아야 수집된다.
   메일은 SMTP(`mail.pointmobile.com:587`, STARTTLS)로 보낸다.

## 이 PC 에서 띄우기

```powershell
cd web; npm install
# web\.env.local — web\.env.example 참고(DATABASE_URL 은 로컬 PostgreSQL 의 sbnext 를 써도 된다, 표는 sb 스키마)
powershell -ExecutionPolicy Bypass -File scripts\start.ps1     # 3070 + 5분 주기 작업
```

개발 중에는 `cd web; npm run dev`. 화면을 고친 뒤 `start.ps1` 로 띄울 때는 `web\.next` 를 지우면 다시 빌드한다.

## 화면

- `/faq` FAQ — 처리한 이슈의 기록(해결 사례)과 Confluence 에서 옮긴 How-to · Troubleshooting 문서 검색 · 열람(`/faq/<id>`)
- `/wiki` LLM Wiki — 질문하면 Claude 가 FAQ 를 찾아 읽고 출처를 단 해결 가이드를 준다
- `/` SB 문서(업로드) — 내 담당 문서(관리자는 전체). 편집 · 검토 요청 · 확정(→ FAQ 에 올라감) · 폐기
- `/issues` 이슈 — Redmine 이슈 목록 · 타임라인
- `/stats` 통계(업무일 기준 — 주말 · 한국 공휴일 제외, `server/issuetrack/krHolidays.ts`)
- `/usage` Claude 사용량
- `/settings` 검증 모드 · Redmine · 메일 발송 · Claude · SB 동작 · 계정 · 사내 인원 · 메일 문구 · 비밀번호

## FAQ · LLM Wiki

기획은 `docs/FAQ_PLAN.md`. 문서는 `sb.kb_articles` 한 표에 있다 — Confluence 이관분(SB · Knowledge Articles · Troubleshooting, 1,314건)과
업로드에서 확정한 SB 문서(확정하면 올라가고, 확정 취소하면 내려간다).

- 검색: PGroonga(제목 · 적용 모델 · 본문, 한국어 · 영어) — Supabase 에만 있다. 로컬 PostgreSQL 에서는 ILIKE 로 대신한다.
- 이미지: `sb.kb_files`(DB)에 두고 `/api/kb/files/<id>` 로 준다. 큰 첨부(zip · apk · mp4 …)는 원본 Confluence 링크.
- LLM Wiki: Claude 가 `search_faq` · `get_faq` 도구로 찾아 읽고(최대 6번) `search_result` 인용으로 출처를 단다.
  질문 · 답 · 인용 · 평가는 `sb.qa_logs` — 관리자는 'FAQ 보강 거리'(못 찾음 · 👎)를 본다.
- Confluence 다시 옮기기(덮어쓴다):
  1. `python -I web/scripts/confluence/extract_dump.py <Confluence_backup.sql> confluence.sqlite`
  2. `node --env-file=.env.local --import tsx scripts/import-confluence.mts confluence.sqlite`
  3. `node --env-file=.env.local --import tsx scripts/fetch-confluence-images.mts`(SOURCE_DATABASE_URL 의 Confluence 계정으로 받는다)
- 확인: `scripts/e2e-faq.mts` · `scripts/e2e-wiki.mts <앱 주소>`

## Claude

API 키(`ANTHROPIC_API_KEY`)로 부른다. 기본 모델 `claude-opus-5-5`(`SB_MODEL`), 생각 깊이 `medium`(`SB_EFFORT`).
정책 거절에 대비해 서버 측 대체 모델(`fallbacks: "default"`)을 켰다. 호출마다 사용량 · 추정 비용을 `sb.token_usage` 에 남긴다.
예전 앱의 '구독(이 PC 의 Claude Code)' 경로는 웹 서버에 Claude Code 가 없어 없앴다.

## 검증 모드

`live_writes` 가 0(기본, `TWN_LIVE_WRITES`)이면 메일을 보내지 않고 `sb.shadow_writes` 에 기록만 한다(`server/shadow.ts`).
운영 전환은 관리자가 [설정 → 검증 모드 · 운영 전환] 에서 한다. tw-next · tw-automation 과 같은 메일 계정을 쓰므로,
한쪽만 실제로 쓰게 둬야 같은 메일이 두 번 나가지 않는다.

## 예전 앱에서 바뀐 것

- 서버리스라 프로세스 메모리에 두던 상태를 DB 로 옮겼다 — 초안 생성 중 표시(`rm_sb_docs.generating_since`),
  작업 잠금(`sb.job_locks`), 마지막 주기 작업 결과 · 수동 수집 결과(`rm_sync_state`), 검증 모드 기록(`sb.shadow_writes`).
- 시각은 모두 `timestamptz`(UTC 저장, 화면 · 메일은 KST).
- Confluence 업로드(2026-10-15)는 이미 없앴다. 예전 '업로드 완료' 문서는 이관 때 '확정'(approved)이 된다.
