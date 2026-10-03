import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { addUser, asUser, createDb, serviceReviewDb } from './db.ts'
import { handleReview } from '../supabase/functions/_shared/review-handler.ts'

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
let db: PGlite

async function addItem(uid: string, expression = 'put off', meaning = '미루다') {
  const r = await asUser<any>(db, uid, 'select add_personal_item($1,$2,$3) as id', [randomUUID(), expression, meaning])
  return r.rows[0].id as string
}
const card = async (id: string) => (await db.query<any>('select * from cards where id=$1', [id])).rows[0]
const summary = async (uid: string, now: Date) =>
  (await asUser<any>(db, uid, 'select today_summary($1) as s', [now.toISOString()])).rows[0].s
const review = (uid: string, cardId: string, rating: number, version: number, now: Date, request_id = randomUUID()) =>
  handleReview(serviceReviewDb(db), uid, { card_id: cardId, rating, expected_card_version: version, request_id }, now)

beforeEach(async () => {
  db = await createDb()
  await addUser(db, A); await addUser(db, B)
  await asUser(db, A, 'select ensure_user_setup()'); await asUser(db, B, 'select ensure_user_setup()')
})

describe('등록', () => {
  it('3,000개 등록: 모두 미학습, 오늘 복습 수 0', async () => {
    const col = (await db.query<any>(`select id from collections where user_id=$1`, [A])).rows[0].id
    await db.exec(`
      insert into items (user_id, collection_id, expression, meaning, origin)
        select '${A}', '${col}', 'word' || g, '뜻' || g, 'import' from generate_series(1,3000) g;
      insert into cards (user_id, item_id) select user_id, id from items where user_id='${A}';`)
    const s = await summary(A, new Date('2026-12-31T00:00:00Z'))
    expect(s.unlearned_total).toBe(3000)
    expect(s.due_reviews).toBe(0)
    expect(s.overdue_reviews).toBe(0)
  })

  it('같은 request_id 재전송은 항목을 한 번만 생성', async () => {
    const rid = randomUUID()
    const r1 = await asUser<any>(db, A, 'select add_personal_item($1,$2,$3) as id', [rid, 'x', 'y'])
    const r2 = await asUser<any>(db, A, 'select add_personal_item($1,$2,$3) as id', [rid, 'x', 'y'])
    expect(r1.rows[0].id).toBe(r2.rows[0].id)
    expect((await db.query<any>('select count(*)::int n from items')).rows[0].n).toBe(1)
  })

  it('중복 후보는 정규화로 찾되 자동 병합하지 않음', async () => {
    await addItem(A, 'Put  Off', '미루다')
    await addItem(A, 'put off', '연기하다')
    const d = await asUser<any>(db, A, 'select * from find_duplicate_candidates($1)', ['  PUT OFF '])
    expect(d.rows.length).toBe(2)
  })

  it('필수 입력 누락은 거절', async () => {
    await expect(asUser(db, A, 'select add_personal_item($1,$2,$3)', [randomUUID(), ' ', '뜻'])).rejects.toThrow(/expression_required/)
  })
})

describe('복습 저장', () => {
  const T = new Date('2026-10-03T03:00:00Z')

  it('첫 평가: 학습 시작 시각·FSRS 상태·이벤트 저장', async () => {
    const id = await addItem(A)
    const res = await review(A, id, 3, 0, T)
    expect(res.status).toBe(200)
    const c = await card(id)
    expect(new Date(c.introduced_at).toISOString()).toBe(T.toISOString())
    expect(c.state).toBe(1); expect(c.reps).toBe(1); expect(c.version).toBe(1)
    const ev = (await db.query<any>('select * from review_events')).rows
    expect(ev.length).toBe(1)
    expect(ev[0].is_introduction).toBe(true)
    expect(ev[0].predicted_retrievability).toBeNull()
    expect(ev[0].scheduler_version).toMatch(/ts-fsrs/)
    expect((await summary(A, T)).new_learned_today).toBe(1)
  })

  it('같은 요청 재전송: 이벤트 한 번만 생성', async () => {
    const id = await addItem(A)
    const rid = randomUUID()
    expect((await review(A, id, 3, 0, T, rid)).status).toBe(200)
    const again = await review(A, id, 3, 0, T, rid)
    expect(again.status).toBe(200)
    expect(again.body.status).toBe('duplicate')
    expect((await db.query<any>('select count(*)::int n from review_events')).rows[0].n).toBe(1)
  })

  it('두 기기 동시 평가: 하나만 적용, 나머지는 충돌', async () => {
    const id = await addItem(A)
    const [r1, r2] = await Promise.all([review(A, id, 3, 0, T), review(A, id, 1, 0, T)])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    expect((await db.query<any>('select count(*)::int n from review_events')).rows[0].n).toBe(1)
    expect((await card(id)).version).toBe(1)
  })

  it('두 번째 평가부터 예측 회상 확률 기록', async () => {
    const id = await addItem(A)
    await review(A, id, 4, 0, T)
    const later = new Date(new Date((await card(id)).due_at).getTime() + 3 * 86_400_000)
    expect((await review(A, id, 3, 1, later)).status).toBe(200)
    const ev = (await db.query<any>('select * from review_events order by reviewed_at')).rows
    expect(ev[1].predicted_retrievability).toBeGreaterThan(0)
    expect(ev[1].predicted_retrievability).toBeLessThan(1)
    expect(ev[1].is_introduction).toBe(false)
  })

  it('클라이언트가 보낸 상태값은 무시, 잘못된 평가는 거절', async () => {
    const id = await addItem(A)
    const bad = await handleReview(serviceReviewDb(db), A, { card_id: id, rating: 5, expected_card_version: 0, request_id: randomUUID() }, T)
    expect(bad.status).toBe(400)
    await handleReview(serviceReviewDb(db), A,
      { card_id: id, rating: 3, expected_card_version: 0, request_id: randomUUID(), stability: 999, due: '2099-01-01' }, T)
    expect((await card(id)).stability).not.toBe(999)
  })

  it('다른 사용자 카드는 평가 불가', async () => {
    const id = await addItem(A)
    expect((await review(B, id, 3, 0, T)).status).toBe(404)
  })
})

describe('평가 취소', () => {
  const T = new Date('2026-10-03T03:00:00Z')

  it('최초 평가 취소: 미학습 복구, 신규 집계 제외, 이벤트 보존', async () => {
    const id = await addItem(A)
    const before = await card(id)
    const res = await review(A, id, 3, 0, T)
    const r = await asUser<any>(db, A, 'select revert_review($1) as r', [res.body.event_id])
    expect(r.rows[0].r.status).toBe('ok')
    const c = await card(id)
    expect(c.introduced_at).toBeNull()
    expect(c.state).toBe(0); expect(c.reps).toBe(0)
    expect(new Date(c.due_at).toISOString()).toBe(new Date(before.due_at).toISOString())
    expect((await summary(A, T)).new_learned_today).toBe(0)
    const ev = (await db.query<any>('select * from review_events')).rows
    expect(ev.length).toBe(1); expect(ev[0].reverted_at).not.toBeNull()
  })

  it('후속 평가가 있으면 이전 평가 취소 거절', async () => {
    const id = await addItem(A)
    const first = await review(A, id, 3, 0, T)
    await review(A, id, 3, 1, new Date(T.getTime() + 20 * 60_000))
    const r = await asUser<any>(db, A, 'select revert_review($1) as r', [first.body.event_id])
    expect(r.rows[0].r.status).toBe('version_conflict')
  })

  it('다른 사용자는 취소 불가', async () => {
    const id = await addItem(A)
    const res = await review(A, id, 3, 0, T)
    const r = await asUser<any>(db, B, 'select revert_review($1) as r', [res.body.event_id])
    expect(r.rows[0].r.status).toBe('not_found')
  })
})

describe('한국 자정 전후 신규 학습 집계', () => {
  it('23:59 KST 학습은 그날, 00:01 KST부터 새 날', async () => {
    const id = await addItem(A)
    const t2359 = new Date('2026-10-03T14:59:00Z') // 10/3 23:59 KST
    await review(A, id, 3, 0, t2359)
    expect((await summary(A, t2359)).new_learned_today).toBe(1)
    expect((await summary(A, new Date('2026-10-03T15:01:00Z'))).new_learned_today).toBe(0)
    expect(new Date((await summary(A, t2359)).day_start).toISOString()).toBe('2026-10-02T15:00:00.000Z')
  })
})

describe('접근 제어 (RLS)', () => {
  it('다른 사용자 데이터 조회 불가', async () => {
    await addItem(A)
    expect((await asUser(db, B, 'select * from items')).rows.length).toBe(0)
    expect((await asUser(db, B, 'select * from cards')).rows.length).toBe(0)
    expect((await asUser(db, A, 'select * from cards')).rows.length).toBe(2) // 양방향 카드 2장
  })

  it('브라우저 사용자는 카드 직접 수정·apply_review 호출 불가', async () => {
    const id = await addItem(A)
    await expect(asUser(db, A, `update cards set stability = 99 where id = $1`, [id])).rejects.toThrow(/permission denied/)
    await expect(asUser(db, A, `insert into review_events (id) values (gen_random_uuid())`)).rejects.toThrow(/permission denied/)
    await expect(asUser(db, A,
      `select apply_review($1,$2,gen_random_uuid(),0,3::smallint,now(),'{}','{}',null,null,'x','{}',0.9)`, [A, id]))
      .rejects.toThrow(/permission denied/)
  })

  it('로그인하지 않으면 함수 호출 불가', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.exec('set local role anon')
      return tx.query('select today_summary()')
    })).rejects.toThrow(/permission denied/)
  })
})
