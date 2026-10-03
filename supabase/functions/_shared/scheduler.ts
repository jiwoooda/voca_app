// FSRS 일정 계산 (서버 전용). ts-fsrs 5.4.2 공식 구현을 그대로 사용한다.
//
// 선택한 설정 (docs/SCHEDULER.md 참고)
// - w: 라이브러리 버전 기본값 (FSRS-6, 개인 최적화 없음)
// - request_retention: 사용자 설정 desired_retention (기본 0.90)
// - enable_short_term: true (라이브러리 기본)
// - learning_steps: ['1m', '10m'], relearning_steps: ['10m'] (라이브러리 기본)
// - enable_fuzz: false (라이브러리 기본, 결과 재현 가능)
// - maximum_interval: 36500 (라이브러리 기본)
// 라이브러리 결과에 별도 간격 규칙을 덧붙이지 않는다.
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  FSRSVersion,
  State,
  type Card,
  type FSRSParameters,
  type Grade,
} from 'ts-fsrs'

export const SCHEDULER_VERSION = `ts-fsrs ${FSRSVersion}`

/** DB cards 행 중 FSRS 계산에 필요한 부분 */
export interface CardRow {
  due_at: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review_at: string | null
}

/** before_state / after_state 로 저장하는 직렬화 형식 */
export interface StoredCardState {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review: string | null
}

export function buildParameters(desiredRetention: number): FSRSParameters {
  return generatorParameters({
    request_retention: desiredRetention,
    enable_fuzz: false,
    enable_short_term: true,
  })
}

export function rowToCard(row: CardRow): Card {
  return {
    due: new Date(row.due_at),
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state as State,
    last_review: row.last_review_at ? new Date(row.last_review_at) : undefined,
  }
}

export function serialize(card: Card): StoredCardState {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  }
}

export function isGrade(n: unknown): n is Grade {
  return n === 1 || n === 2 || n === 3 || n === 4
}

export interface ScheduleResult {
  before: StoredCardState
  after: StoredCardState
  /** 평가 직전 예측 회상 확률. 한 번도 복습하지 않은 카드는 계산 불가 → null */
  predictedRetrievability: number | null
  parameters: FSRSParameters
}

/**
 * 현재 카드 상태와 평가, 서버 시각으로 다음 상태를 계산한다.
 * 경과 시간은 last_review와 now의 실제 차이로 라이브러리가 계산한다.
 */
export function schedule(row: CardRow, rating: Grade, now: Date, desiredRetention: number): ScheduleResult {
  const parameters = buildParameters(desiredRetention)
  const f = fsrs(parameters)
  const card = rowToCard(row)
  const predicted =
    card.state === State.New || !card.last_review ? null : f.get_retrievability(card, now, false)
  const { card: next } = f.next(card, now, rating)
  return {
    before: serialize(card),
    after: serialize(next),
    predictedRetrievability: predicted,
    parameters,
  }
}

/** 새 카드의 초기 상태 (DB 기본값과 일치하는지 테스트에서 확인) */
export function emptyCardState(now: Date): StoredCardState {
  return serialize(createEmptyCard(now))
}
