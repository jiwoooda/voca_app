import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/lib/csv.ts'

describe('CSV 파싱', () => {
  it('BOM·따옴표·쉼표·줄바꿈 처리', () => {
    const text = '﻿expression,meaning,example,example_translation,note,source\r\n' +
      'put off,미루다,We put off the meeting.,우리는 회의를 미뤘다.,,책\r\n' +
      '"look up to","존경하다, 우러러보다","She said, ""I look up to him.""","그녀가 말했다,\n""나는 그를 존경해""",,\r\n'
    const r = parseCsv(text)
    expect(r.fatal).toBeNull()
    expect(r.errors).toEqual([])
    expect(r.valid.length).toBe(2)
    expect(r.valid[1].meaning).toBe('존경하다, 우러러보다')
    expect(r.valid[1].example).toBe('She said, "I look up to him."')
    expect(r.valid[1].example_translation).toContain('\n')
  })

  it('필수 열 없으면 전체 오류', () => {
    expect(parseCsv('word,뜻\na,b').fatal).toMatch(/expression, meaning/)
  })

  it('오류 행은 행 번호와 이유', () => {
    const r = parseCsv('expression,meaning\nok,좋아\n,뜻만\n표현만,\n')
    expect(r.valid.length).toBe(1)
    expect(r.errors).toEqual([
      { row: 3, reason: 'expression 비어 있음' },
      { row: 4, reason: 'meaning 비어 있음' },
    ])
  })

  it('열 개수 초과 행 표시', () => {
    const r = parseCsv('expression,meaning\na,b,c\n')
    expect(r.errors[0].row).toBe(2)
    expect(r.errors[0].reason).toMatch(/열 개수/)
  })

  it('파일 내 중복 표시 (병합하지 않음)', () => {
    const r = parseCsv('expression,meaning\nPut off,미루다\nput  off,연기하다\n')
    expect(r.valid.length).toBe(2)
    expect(r.inFileDuplicates).toEqual([{ normalized: 'put off', rows: [2, 3] }])
  })

  it('대소문자 열 이름과 빈 줄 허용, 모르는 열은 무시 목록', () => {
    const r = parseCsv('Expression,Meaning,Level\n\na,b,1\n\n')
    expect(r.valid.length).toBe(1)
    expect(r.ignoredColumns).toEqual(['level'])
  })
})
