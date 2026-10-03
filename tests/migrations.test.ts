import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { addUser, asUser, createDb } from './db.ts'

const A = '00000000-0000-0000-0000-00000000000a'

describe('마이그레이션', () => {
  it('이미 적용된 DB에 다시 실행해도 오류 없이 데이터 유지 (GitHub 연동 재실행 대비)', async () => {
    const db = await createDb()
    await addUser(db, A)
    await asUser(db, A, 'select add_personal_item($1,$2,$3)', [randomUUID(), 'put off', '미루다'])
    const dir = new URL('../supabase/migrations/', import.meta.url)
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(new URL(f, dir), 'utf8'))
    }
    expect((await asUser(db, A, 'select * from items')).rows.length).toBe(1)
  })
})

describe('설정', () => {
  it('신규 기본 30, 설정 변경·검증', async () => {
    const db = await createDb()
    await addUser(db, A)
    await asUser(db, A, 'select ensure_user_setup()')
    const s0 = (await asUser<any>(db, A, 'select * from user_settings')).rows[0]
    expect(s0.daily_new_limit).toBe(30)
    const r = (await asUser<any>(db, A, 'select update_my_settings(40, 5, 0.85) as r')).rows[0].r
    expect(r.daily_new_limit).toBe(40)
    await expect(asUser(db, A, 'select update_my_settings(40, 5, 0.5)')).rejects.toThrow(/desired_retention/)
  })
})
