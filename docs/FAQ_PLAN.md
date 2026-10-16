# FAQ · LLM Wiki 기획

## 목적

우리가 처리한 이슈를 **기록(history)으로 남기고**, 다음 이슈를 처리할 때 **비슷한 사례를 빨리 찾아 읽게** 하는 사내 지식 저장소.
최종 목표는 **LLM Wiki** — 아무 질문에나 AI 가 FAQ 를 찾아 읽고 **출처를 단 해결 가이드**를 준다.

## 무엇이 FAQ 에 들어가는가

| 출처 | 종류(kind) | 양 |
|---|---|---|
| Confluence `SB`(Solution Buffer) | `resolution` — Redmine 이슈 하나의 해결 기록 | 900여 건 |
| Confluence `faq`(Knowledge Articles) | `how_to` · `troubleshooting` · `guide` | 340여 건 |
| Confluence `TRguide`(Troubleshooting) | `troubleshooting` — 증상 제목의 해결 가이드 | 100여 건 |
| 이 앱의 SB 문서(업로드 → 확정) | `resolution` | 확정할 때마다 |

원본은 2026-09-15 Confluence 백업(pg_dump)에서 뽑고, 첨부(이미지 등)는 Confluence REST API 에서 받는다.
목록만 모아 둔 페이지(라벨 목록 · 하위 페이지 목록 매크로뿐인 페이지)는 문서로 옮기지 않고, 그 아래 문서들의 **분류(category)** 로 쓴다.

## 문서 구조 — KCS(Knowledge-Centered Service) 를 가볍게

기술지원 지식관리의 표준인 KCS 는 문서를 **증상(Issue) / 환경(Environment) / 해결(Resolution) / 원인(Cause)** 으로 나눈다.
'환경' — 어느 모델 · OS · 앱 버전인가 — 이 같은 증상을 다른 해결로 가르므로 **걸러 볼 수 있는 필드**로 둔다.

`sb.kb_articles` 한 표에 모은다.

- 식별 · 분류: `kind`, `title`, `category`(Confluence 상위 페이지 경로), `labels[]`(Confluence 라벨 그대로)
- 환경: `applies_to`(원문), `products[]`(PM451 · PM85 처럼 맞춘 모델 코드)
- 본문: `body_html`(정리한 HTML), `body_text`(검색 · LLM 용 평문), `raw_storage`(Confluence 원본 XHTML — 다시 변환할 때)
- KCS 칸: `symptom` · `cause` · `resolution` · `summary` — 비워 두고 LLM 으로 나중에 채운다(LLM Wiki 정확도를 올리는 다음 단계)
- 출처: `source`(confluence · sb), `source_space`, `source_page_id`, `source_url`, `sb_doc_id`, `redmine_issue_ids[]`
- 관리: `disclosure`(internal · public · partner · ascp — Confluence 라벨 confidential · partner · ascp 에서), `state`(published · archived),
  `author`, `created_at`, `updated_at`, `approved_by`, `approved_at`
- 쓰임: `view_count`, `helpful_up`, `helpful_down` — 자주 읽히는 문서 · 부족한 문서를 가린다

첨부는 `sb.kb_attachments`, LLM Wiki 질문 기록은 `sb.qa_logs`.

## 검색

Supabase(PostgreSQL 17)의 확장으로:

- **PGroonga** — 제목 · 본문 전문 검색. 사전 없이 2글자 단위로 색인해 한국어 · 영어가 섞여도 된다(PostgreSQL 기본 전문 검색은 한국어 사전이 없다).
- **pg_trgm** — 제목 · 모델명의 비슷한 글자(PM-85 / PM85 등).
- 걸러 보기: 종류 · 모델 · 스페이스 · 공개 등급 · 라벨.
- 다음 단계: 질문 기록에서 '못 찾음'이 쌓이면 **Voyage 임베딩(voyage-4, pgvector)** 을 더해 PGroonga 와 RRF 로 섞는다.

## FAQ 화면

- 검색이 먼저 — 큰 검색창, 결과마다 종류 · 모델 · 공개 등급 · 날짜 · 본문 미리보기(검색어 강조).
- 왼쪽 걸러 보기: 종류 · 모델 · 분류 · 공개 등급.
- 문서 화면(`/faq/[id]`): 본문 · 첨부 · 원본 링크(Confluence · Redmine) · 같은 모델/라벨의 관련 문서 · '도움이 됐나요'.
- 확정한 SB 문서는 '업로드 → 확정' 순간 FAQ 에 들어가고, 확정을 취소하면 빠진다.

## LLM Wiki

- Claude(Opus 5.5) 에이전트가 **도구로 FAQ 를 찾는다** — `search_articles(query, products?, kind?)` · `get_article(id)`.
  한국어/영어로 바꿔 다시 찾고, 모델로 거르고, 여러 번 찾을 수 있다(최대 6번).
- 찾은 문서를 **search_result 블록**으로 넘겨 **인용**을 받는다 — 답의 각 단계에 출처 문서가 붙는다.
- 규칙: FAQ 에 근거가 있는 것만 답한다. 없으면 '없다'고 하고 비슷한 문서를 보여 준다. 공개 등급(internal 등)을 표시한다.
- 답은 흘려 보낸다(스트리밍), 진행 중에는 '검색 중: …'을 보인다.
- 질문 · 답 · 인용 문서 · 👍/👎 를 `qa_logs` 에 남긴다 → '못 찾음' · 👎 를 모아 새 문서 거리로 쓴다(KCS 의 지식 공백 찾기).

## 단계

1. **이관 · FAQ** — 스키마, Confluence 변환 · 이관, 확정 → FAQ 연결, FAQ 화면 개편, 이미지 전달
2. **LLM Wiki** — 에이전트 · 인용 · 질문 기록(테스트에는 Anthropic API 크레딧 필요)
3. **정확도** — KCS 칸 LLM 채우기, Voyage 임베딩 하이브리드 검색, 첨부를 Supabase Storage 로
