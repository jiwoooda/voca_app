import Papa from 'papaparse'

export const COLUMNS = ['expression', 'meaning', 'example', 'example_translation', 'note', 'source', 'phonetic'] as const
export type CsvRow = { row: number } & Record<(typeof COLUMNS)[number], string>

export interface ParsedCsv {
  /** 헤더 문제 등으로 파일 전체를 읽을 수 없을 때 */
  fatal: string | null
  valid: CsvRow[]
  errors: { row: number; reason: string }[]
  /** 파일 안에서 같은 표현(정규화 기준)이 나온 행 번호들 */
  inFileDuplicates: { normalized: string; rows: number[] }[]
  ignoredColumns: string[]
}

export const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

const LIMITS: Record<string, number> = {
  expression: 300, meaning: 1000, example: 2000, example_translation: 2000, note: 2000, source: 300, phonetic: 200,
}

/** CSV 텍스트를 파싱·검사한다. 행 번호는 스프레드시트 기준(헤더 = 1행). */
export function parseCsv(text: string): ParsedCsv {
  const empty: ParsedCsv = { fatal: null, valid: [], errors: [], inFileDuplicates: [], ignoredColumns: [] }
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^﻿/, '').trim().toLowerCase(),
  })
  const fields = res.meta.fields ?? []
  const missing = ['expression', 'meaning'].filter((c) => !fields.includes(c))
  if (missing.length) {
    return { ...empty, fatal: `필수 열이 없어요: ${missing.join(', ')} (첫 줄에 열 이름이 있어야 해요)` }
  }
  const rowErrors = new Map<number, string>()
  for (const e of res.errors) {
    if (e.row != null) rowErrors.set(e.row, e.code === 'TooManyFields' ? '열 개수가 너무 많음 (쉼표가 들어간 값은 따옴표로 감싸야 해요)' : e.code === 'TooFewFields' ? '열 개수가 부족함' : e.message)
  }

  const out: ParsedCsv = { ...empty, ignoredColumns: fields.filter((f) => !(COLUMNS as readonly string[]).includes(f)) }
  const seen = new Map<string, number[]>()

  // 행 번호: 따옴표 안 줄바꿈이 있어도 '몇 번째 데이터 행'인지로 계산 (헤더 = 1행)
  res.data.forEach((raw, i) => {
    const rowNo = i + 2
    const r = { row: rowNo } as CsvRow
    for (const c of COLUMNS) r[c] = (raw[c] ?? '').trim()
    let reason = rowErrors.get(i) ?? null
    if (!reason && !r.expression) reason = 'expression 비어 있음'
    if (!reason && !r.meaning) reason = 'meaning 비어 있음'
    if (!reason) {
      for (const c of COLUMNS) if (r[c].length > LIMITS[c]) { reason = `${c} ${LIMITS[c]}자 초과`; break }
    }
    if (reason) return void out.errors.push({ row: rowNo, reason })
    out.valid.push(r)
    const n = normalize(r.expression)
    seen.set(n, [...(seen.get(n) ?? []), rowNo])
  })
  out.inFileDuplicates = [...seen].filter(([, rows]) => rows.length > 1).map(([normalized, rows]) => ({ normalized, rows }))
  return out
}
