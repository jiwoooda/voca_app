import { describe, expect, it } from 'vitest'
import { createEmptyCard, fsrs, generatorParameters, State } from 'ts-fsrs'
import { schedule, emptyCardState, type CardRow } from '../supabase/functions/_shared/scheduler.ts'

const T0 = new Date('2026-10-01T00:00:00Z')
const newRow = (): CardRow => ({
  due_at: T0.toISOString(), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
  learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review_at: null,
})
const toRow = (s: ReturnType<typeof schedule>['after']): CardRow => ({ ...s, due_at: s.due, last_review_at: s.last_review })

describe('FSRS 스케줄 (시간 고정)', () => {
  it('DB 기본 카드 값 = ts-fsrs createEmptyCard', () => {
    expect(emptyCardState(T0)).toEqual({ due: T0.toISOString(), stability: 0, difficulty: 0, elapsed_days: 0,
      scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null })
  })

  it('새 카드 평가: 라이브러리 결과와 동일, 예측 확률은 null', () => {
    for (const rating of [1, 2, 3, 4] as const) {
      const r = schedule(newRow(), rating, T0, 0.9)
      const expected = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: false })).next(createEmptyCard(T0), T0, rating).card
      expect(r.after.due).toBe(expected.due.toISOString())
      expect(r.after.stability).toBe(expected.stability)
      expect(r.predictedRetrievability).toBeNull()
    }
  })

  it('Good → 10분 뒤 학습 단계 (기본 learning_steps 1m,10m)', () => {
    const r = schedule(newRow(), 3, T0, 0.9)
    expect(r.after.state).toBe(State.Learning)
    expect(new Date(r.after.due).getTime() - T0.getTime()).toBe(10 * 60_000)
  })

  it('며칠 늦은 복습은 실제 경과 시간으로 계산', () => {
    // 학습 → 복습 단계까지 진행
    let row = toRow(schedule(newRow(), 4, T0, 0.9).after)
    expect(row.state).toBe(State.Review)
    const onTime = new Date(row.due_at)
    const late = new Date(onTime.getTime() + 5 * 86_400_000)
    const a = schedule(row, 3, onTime, 0.9)
    const b = schedule(row, 3, late, 0.9)
    expect(a.predictedRetrievability!).toBeGreaterThan(b.predictedRetrievability!)
    expect(b.after.stability).not.toBe(a.after.stability)
    expect(b.after.last_review).toBe(late.toISOString())
  })

  it('목표 회상률이 높을수록 간격이 짧다', () => {
    const row = toRow(schedule(newRow(), 4, T0, 0.9).after)
    const now = new Date(row.due_at)
    const r90 = schedule(row, 3, now, 0.9)
    const r95 = schedule(row, 3, now, 0.95)
    expect(r95.after.scheduled_days).toBeLessThan(r90.after.scheduled_days)
  })
})
