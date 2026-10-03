// 테스트용 Postgres (PGlite) + Supabase auth/역할 흉내.
// 실제 마이그레이션 SQL을 그대로 실행해 DB 함수·RLS를 검증한다.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import type { ReviewDb } from '../supabase/functions/_shared/review-handler.ts'

const SUPABASE_MOCK = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
`

export async function createDb() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(SUPABASE_MOCK)
  await db.exec(readFileSync(new URL('../supabase/migrations/20261003000000_init.sql', import.meta.url), 'utf8'))
  await db.exec(`grant select, insert, update, delete on all tables in schema public to service_role;`)
  return db
}

export async function addUser(db: PGlite, id: string) {
  await db.query('insert into auth.users (id) values ($1)', [id])
}

/** 로그인 사용자로서 쿼리 실행 (RLS 적용) */
export async function asUser<T = any>(db: PGlite, uid: string, sql: string, params: unknown[] = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated`)
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
    return tx.query<T>(sql, params)
  })
}

/** Edge Function이 service_role로 하는 일을 흉내 */
export function serviceReviewDb(db: PGlite): ReviewDb {
  const svc = async <T = any>(sql: string, params: unknown[]) =>
    db.transaction(async (tx) => {
      await tx.exec('set local role service_role')
      return tx.query<T>(sql, params)
    })
  return {
    async getCard(uid, cardId) {
      const r = await svc('select * from cards where id = $1 and user_id = $2', [cardId, uid])
      const row: any = r.rows[0]
      if (!row) return null
      return { ...row, due_at: new Date(row.due_at).toISOString(),
        last_review_at: row.last_review_at ? new Date(row.last_review_at).toISOString() : null }
    },
    async getDesiredRetention(uid) {
      const r = await svc<any>('select desired_retention from user_settings where user_id = $1', [uid])
      return r.rows[0] ? Number(r.rows[0].desired_retention) : 0.9
    },
    async applyReview(a: any) {
      const r = await svc<any>(
        `select apply_review($1,$2,$3,$4,$5::smallint,$6,$7,$8,$9,$10,$11,$12,$13) as r`,
        [a.p_user_id, a.p_card_id, a.p_request_id, a.p_expected_version, a.p_rating, a.p_reviewed_at,
         JSON.stringify(a.p_before), JSON.stringify(a.p_after), a.p_predicted_retrievability, a.p_response_ms,
         a.p_scheduler_version, JSON.stringify(a.p_parameters), a.p_desired_retention])
      return r.rows[0].r
    },
  }
}
