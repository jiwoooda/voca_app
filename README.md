# 표현 노트 — 개인 영어 표현 학습 앱

React + TypeScript + Vite / Supabase(Auth, Postgres, Edge Functions) / `ts-fsrs` 5.4.2

## 구조

```
src/                         화면 (브라우저)
supabase/migrations/         DB 스키마·RLS·트랜잭션 함수
supabase/functions/review/   복습 저장 Edge Function (FSRS 계산)
supabase/functions/_shared/  FSRS 계산·요청 처리 (테스트와 공유)
tests/                       FSRS 고정 시간 테스트 + DB 함수 테스트(PGlite)
docs/SCHEDULER.md            FSRS 설정
```

## 설정

1. Supabase 프로젝트 생성.
2. DB 적용: `supabase link --project-ref <ref>` → `supabase db push`
   (또는 SQL Editor에서 `supabase/migrations/*.sql` 실행)
3. 함수 배포: `supabase functions deploy review`
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 Supabase가 자동 주입)
   선택: `supabase secrets set ALLOWED_ORIGIN=https://<배포 도메인>`
4. `.env.example`을 `.env`로 복사해 URL과 **anon 키만** 입력.
5. `npm install` → `npm run dev`

service_role 키는 브라우저 코드·`.env`·Git에 넣지 않는다.

## 테스트

```
npm test
```

실제 마이그레이션 SQL을 PGlite(Postgres)에서 실행해 검증한다. Supabase 클라우드 연동 자체(인증 메일, Edge Function 배포)는 실제 프로젝트에서 확인해야 한다.
