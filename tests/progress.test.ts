import { beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { addUser, asUser, createDb, serviceReviewDb } from './db.ts'
import { handleReview } from '../supabase/functions/_shared/review-handler.ts'

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const T = new Date('2026-10-06T03:00:00Z')
let db: PGlite

beforeEach(async () => {
  db = await createDb()
  await addUser(db, A); await addUser(db, B)
  await asUser(db, A, 'select ensure_user_setup()')
})

const imp = (rows: unknown[]) =>
  asUser<any>(db, A, 'select import_items($1,$2,$3) as r', [randomUUID(), '단어장', JSON.stringify(rows)]).then((r) => r.rows[0].r)

describe('발음 기호', () => {
  it('CSV phonetic 열 저장', async () => {
    await imp([{ row: 2, expression: 'mean', meaning: '심술궂은', phonetic: '/miːn/' }])
    expect((await db.query<any>('select phonetic from items')).rows[0].phonetic).toBe('/miːn/')
  })

  it('비어 있을 때만 채우고, 다른 사용자 항목은 못 바꿈', async () => {
    await imp([{ row: 2, expression: 'a', meaning: 'b' }, { row: 3, expression: 'c', meaning: 'd', phonetic: '/x/' }])
    const items = (await db.query<any>('select id, expression from items order by seq')).rows
    await asUser(db, A, 'select set_item_phonetic($1, $2)', [items[0].id, '/eɪ/'])
    await asUser(db, A, 'select set_item_phonetic($1, $2)', [items[1].id, '/덮어쓰기/'])
    await asUser(db, B, 'select set_item_phonetic($1, $2)', [items[0].id, '/hack/'])
    const after = (await db.query<any>('select phonetic, phonetic_checked_at from items order by seq')).rows
    expect(after.map((r: any) => r.phonetic)).toEqual(['/eɪ/', '/x/'])
    expect(after[0].phonetic_checked_at).not.toBeNull()
  })

  it('찾지 못한 경우(null)도 조회 시각 기록', async () => {
    await imp([{ row: 2, expression: 'put off', meaning: '미루다' }])
    const id = (await db.query<any>('select id from items')).rows[0].id
    await asUser(db, A, 'select set_item_phonetic($1, null)', [id])
    const r = (await db.query<any>('select phonetic, phonetic_checked_at from items')).rows[0]
    expect(r.phonetic).toBeNull()
    expect(r.phonetic_checked_at).not.toBeNull()
  })
})

describe('진행 상황', () => {
  it('모음집별 전체·시작·오늘 시작 단어 수 (양방향 카드여도 단어 1개로)', async () => {
    await imp(Array.from({ length: 5 }, (_, i) => ({ row: i + 2, expression: `w${i}`, meaning: 'm' })))
    const cards = (await db.query<any>(`select c.id from cards c join items i on i.id=c.item_id where i.expression in ('w0','w1') order by c.prompt_type`)).rows
    for (const c of cards) {
      await handleReview(serviceReviewDb(db), A, { card_id: c.id, rating: 3, expected_card_version: 0, request_id: randomUUID() }, T)
    }
    const p = (await asUser<any>(db, A, 'select * from collection_progress($1)', [T.toISOString()])).rows
    expect(p.length).toBe(1) // 빈 '내 표현' 모음집은 제외
    expect(p[0]).toMatchObject({ name: '단어장', total: 5, started: 2, started_today: 2 })
    expect((await asUser(db, B, 'select * from collection_progress()')).rows.length).toBe(0)
  })
})
