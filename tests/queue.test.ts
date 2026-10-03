import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { addUser, asUser, createDb, serviceReviewDb } from './db.ts'
import { handleReview } from '../supabase/functions/_shared/review-handler.ts'

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const T = new Date('2026-10-03T03:00:00Z') // 12:00 KST
let db: PGlite

const rows = (n: number, prefix = 'w') =>
  Array.from({ length: n }, (_, i) => ({ row: i + 2, expression: `${prefix}${i + 1}`, meaning: `뜻${i + 1}` }))
const importRows = async (uid: string, r: unknown[], name = '단어장', rid = randomUUID()) =>
  (await asUser<any>(db, uid, 'select import_items($1,$2,$3) as r', [rid, name, JSON.stringify(r)])).rows[0].r
const queue = async (uid: string, now = T, extra = 0) =>
  (await asUser<any>(db, uid, 'select * from get_study_queue($1,$2)', [now.toISOString(), extra])).rows
const addPersonal = async (uid: string, e: string) =>
  (await asUser<any>(db, uid, 'select add_personal_item($1,$2,$3) as id', [randomUUID(), e, '뜻'])).rows[0].id as string
const review = async (uid: string, cardId: string, now = T) => {
  const v = (await db.query<any>('select version from cards where id=$1', [cardId])).rows[0].version
  return handleReview(serviceReviewDb(db), uid, { card_id: cardId, rating: 3, expected_card_version: v, request_id: randomUUID() }, now)
}
const expr = async (cardId: string) =>
  (await db.query<any>('select i.expression from cards c join items i on i.id=c.item_id where c.id=$1', [cardId])).rows[0].expression

beforeEach(async () => {
  db = await createDb()
  await addUser(db, A); await addUser(db, B)
  await asUser(db, A, 'select ensure_user_setup()')
  await asUser(db, A, 'select update_my_settings(10, 3, 0.9)') // 설계서 예시 기준
})

describe('CSV 가져오기', () => {
  it('3,000개 가져오기: 모두 미학습, 복습 0, 신규는 하루 한도(10)만', async () => {
    const r = await importRows(A, rows(3000))
    expect(r.inserted).toBe(3000)
    const s = (await asUser<any>(db, A, 'select today_summary($1) as s', [T.toISOString()])).rows[0].s
    expect(s.unlearned_total).toBe(3000)
    expect(s.due_reviews).toBe(0)
    const q = await queue(A)
    expect(q.length).toBe(10)
    expect(await expr(q[0].card_id)).toBe('w1') // 파일 순서 유지
    expect(await expr(q[9].card_id)).toBe('w10')
  })

  it('서버에서도 검사: 오류 행은 행 번호와 이유를 반환하고 나머지만 저장', async () => {
    const r = await importRows(A, [
      { row: 2, expression: 'ok', meaning: '좋아' },
      { row: 3, expression: '  ', meaning: '뜻' },
      { row: 4, expression: 'x', meaning: '' },
      { row: 5, expression: 'y'.repeat(301), meaning: '뜻' },
    ])
    expect(r.inserted).toBe(1)
    expect(r.errors).toEqual([
      { row: 3, reason: 'expression 비어 있음' },
      { row: 4, reason: 'meaning 비어 있음' },
      { row: 5, reason: 'expression 300자 초과' },
    ])
  })

  it('같은 요청 재전송은 한 번만 생성', async () => {
    const rid = randomUUID()
    await importRows(A, rows(5), '단어장', rid)
    const again = await importRows(A, rows(5), '단어장', rid)
    expect(again.duplicate_request).toBe(true)
    expect((await db.query<any>('select count(*)::int n from items')).rows[0].n).toBe(5)
    expect((await db.query<any>(`select count(*)::int n from collections where kind='imported'`)).rows[0].n).toBe(1)
  })

  it('기존 중복 후보 조회 (정규화 기준)', async () => {
    await addPersonal(A, 'Put Off')
    const d = await asUser<any>(db, A, 'select * from find_existing_duplicates($1)', [['put  off', 'new word']])
    expect(d.rows.map((r: any) => r.normalized)).toEqual(['put off'])
  })

  it('다른 사용자의 가져오기 결과·항목은 보이지 않음', async () => {
    await importRows(A, rows(3))
    expect((await asUser(db, B, 'select * from items')).rows.length).toBe(0)
    expect((await asUser(db, B, 'select * from import_requests')).rows.length).toBe(0)
  })
})

describe('오늘 학습 목록', () => {
  it('개인 3개 + 모음집 7개', async () => {
    await importRows(A, rows(20))
    for (const e of ['p1', 'p2', 'p3', 'p4']) await addPersonal(A, e)
    const q = await queue(A)
    const names = await Promise.all(q.map((x: any) => expr(x.card_id)))
    expect(names).toEqual(['p1', 'p2', 'p3', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])
  })

  it('개인 1개면 개인 1 + 모음집 9, 없으면 모음집 10', async () => {
    await importRows(A, rows(20))
    expect((await queue(A)).length).toBe(10)
    await addPersonal(A, 'p1')
    const names = await Promise.all((await queue(A)).map((x: any) => expr(x.card_id)))
    expect(names[0]).toBe('p1')
    expect(names.length).toBe(10)
  })

  it('오늘 학습한 수만큼 신규 한도 감소, 복습은 먼저 표시', async () => {
    await importRows(A, rows(20))
    const first = (await queue(A))[0].card_id
    await review(A, first) // Good → 10분 뒤 학습 단계
    expect((await queue(A)).length).toBe(9) // 아직 기한 전
    const later = new Date(T.getTime() + 11 * 60_000)
    const q = await queue(A, later)
    expect(q[0]).toEqual({ card_id: first, kind: 'review' })
    expect(q.filter((x: any) => x.kind === 'new').length).toBe(9)
  })

  it('오늘 신규 쉬기: 신규 0개, 복습은 유지 / 다음 날 자동 해제', async () => {
    await importRows(A, rows(20))
    await asUser(db, A, 'select set_new_paused_today(true, $1)', [T.toISOString()])
    expect((await queue(A)).length).toBe(0)
    const tomorrow = new Date(T.getTime() + 86_400_000)
    expect((await queue(A, tomorrow)).length).toBe(10)
  })

  it('명시적 추가 학습은 한도 초과 허용', async () => {
    await importRows(A, rows(20))
    expect((await queue(A, T, 5)).length).toBe(15)
  })

  it('학습 중이 아닌 모음집은 신규 공급 안 함', async () => {
    const r = await importRows(A, rows(5))
    await db.query('update collections set is_active=false where id=$1', [r.collection_id])
    expect((await queue(A)).length).toBe(0)
  })

  it('양방향: 새 단어는 영→한부터, 한→영은 다음 날 (한도에 포함 안 됨)', async () => {
    await importRows(A, rows(20))
    const q1 = await queue(A)
    const pt = async (id: string) => (await db.query<any>('select prompt_type from cards where id=$1', [id])).rows[0].prompt_type
    expect(await pt(q1[0].card_id)).toBe('expression_to_meaning')
    await review(A, q1[0].card_id) // w1 시작
    // 같은 날: w1의 한→영 카드는 아직 안 나옴
    const later = new Date(T.getTime() + 11 * 60_000)
    const sameDay = await queue(A, later)
    for (const x of sameDay) expect(await expr(x.card_id) === 'w1' && (await pt(x.card_id)) === 'meaning_to_expression').toBe(false)
    // 다음 날: 한→영 카드가 신규로 나오고, 신규 단어 한도 10은 그대로
    const tomorrow = new Date(T.getTime() + 86_400_000)
    const next = await queue(A, tomorrow)
    const kinds = await Promise.all(next.filter((x: any) => x.kind === 'new').map(async (x: any) => [await expr(x.card_id), await pt(x.card_id)]))
    expect(kinds).toContainEqual(['w1', 'meaning_to_expression'])
    expect(kinds.filter(([, p]) => p === 'expression_to_meaning').length).toBe(10)
    const s = (await asUser<any>(db, A, 'select today_summary($1) as s', [T.toISOString()])).rows[0].s
    expect(s.new_learned_today).toBe(1)
    expect(s.unlearned_total).toBe(19)
  })

  it('방향 설정: 한→영만이면 한→영 카드만 신규로', async () => {
    await importRows(A, rows(5))
    await asUser(db, A, `select update_my_settings(10, 3, 0.9, 'meaning_to_expression')`)
    const q = await queue(A)
    const pts = await Promise.all(q.map(async (x: any) => (await db.query<any>('select prompt_type from cards where id=$1', [x.card_id])).rows[0].prompt_type))
    expect(new Set(pts)).toEqual(new Set(['meaning_to_expression']))
    expect(q.length).toBe(5)
  })

  it('시작할 때 방향 선택: 그 방향 복습·신규만, 신규 한도는 단어 기준 공유', async () => {
    await importRows(A, rows(20))
    const pt = async (id: string) => (await db.query<any>('select prompt_type from cards where id=$1', [id])).rows[0].prompt_type
    const q = (dir: string | null, now = T) =>
      asUser<any>(db, A, 'select * from get_study_queue($1, 0, $2)', [now.toISOString(), dir]).then((r) => r.rows)
    // 뜻→영어 모드로 w1 시작
    const m2e = await q('meaning_to_expression')
    expect(await pt(m2e[0].card_id)).toBe('meaning_to_expression')
    await review(A, m2e[0].card_id)
    // 영어→뜻 모드: 같은 날 w1의 짝 카드는 안 나오고, 신규 한도는 9 남음
    const e2m = await q('expression_to_meaning')
    expect(e2m.length).toBe(9)
    for (const x of e2m) expect(await pt(x.card_id)).toBe('expression_to_meaning')
    // 11분 뒤 영어→뜻 모드엔 w1 복습이 없고, 뜻→영어 모드엔 있음
    const later = new Date(T.getTime() + 11 * 60_000)
    expect((await q('expression_to_meaning', later)).some((x: any) => x.kind === 'review')).toBe(false)
    expect((await q('meaning_to_expression', later))[0]).toEqual({ card_id: m2e[0].card_id, kind: 'review' })
    // 다음 날 영어→뜻 모드: w1의 영→한 짝 카드가 신규로
    const tomorrow = new Date(T.getTime() + 86_400_000)
    const next = await q('expression_to_meaning', tomorrow)
    expect(await Promise.all(next.map((x: any) => expr(x.card_id)))).toContain('w1')
  })
})
