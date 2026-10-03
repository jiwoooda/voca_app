// 복습 요청 처리 로직. Edge Function과 테스트가 같은 코드를 사용한다.
import { isGrade, schedule, SCHEDULER_VERSION, type CardRow } from './scheduler.ts'

export interface ReviewRequest {
  card_id: string
  rating: number
  expected_card_version: number
  request_id: string
  response_ms?: number | null
}

export interface ReviewDb {
  /** 인증된 사용자 소유 카드만 반환 */
  getCard(userId: string, cardId: string): Promise<(CardRow & { version: number; suspended_at: string | null }) | null>
  getDesiredRetention(userId: string): Promise<number>
  /** apply_review DB 함수 호출 (트랜잭션 + 행 잠금 + 버전 확인) */
  applyReview(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type ReviewResponse = { status: number; body: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validate(input: unknown): ReviewRequest | string {
  if (!input || typeof input !== 'object') return 'invalid_body'
  const b = input as Record<string, unknown>
  if (typeof b.card_id !== 'string' || !UUID.test(b.card_id)) return 'invalid_card_id'
  if (typeof b.request_id !== 'string' || !UUID.test(b.request_id)) return 'invalid_request_id'
  if (!isGrade(b.rating)) return 'invalid_rating'
  if (!Number.isInteger(b.expected_card_version) || (b.expected_card_version as number) < 0)
    return 'invalid_expected_card_version'
  if (b.response_ms != null && (!Number.isInteger(b.response_ms) || (b.response_ms as number) < 0))
    return 'invalid_response_ms'
  // 클라이언트가 보낸 다른 필드(안정성, 다음 복습일 등)는 무시한다.
  return {
    card_id: b.card_id,
    rating: b.rating,
    expected_card_version: b.expected_card_version as number,
    request_id: b.request_id,
    response_ms: (b.response_ms as number | undefined) ?? null,
  }
}

export async function handleReview(
  db: ReviewDb,
  userId: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ReviewResponse> {
  const req = validate(input)
  if (typeof req === 'string') return { status: 400, body: { error: req } }

  const card = await db.getCard(userId, req.card_id)
  if (!card) return { status: 404, body: { error: 'card_not_found' } }

  // 버전이 다르면 계산하지 않고 DB 함수에 판단을 맡긴다
  // (같은 request_id 재전송이면 duplicate, 아니면 version_conflict).
  const retention = await db.getDesiredRetention(userId)
  const s = schedule(card, req.rating as 1 | 2 | 3 | 4, now, retention)

  const result = await db.applyReview({
    p_user_id: userId,
    p_card_id: req.card_id,
    p_request_id: req.request_id,
    p_expected_version: req.expected_card_version,
    p_rating: req.rating,
    p_reviewed_at: now.toISOString(),
    p_before: s.before,
    p_after: s.after,
    p_predicted_retrievability: s.predictedRetrievability,
    p_response_ms: req.response_ms,
    p_scheduler_version: SCHEDULER_VERSION,
    p_parameters: s.parameters,
    p_desired_retention: retention,
  })

  switch (result.status) {
    case 'ok':
    case 'duplicate':
      return { status: 200, body: result }
    case 'version_conflict':
    case 'request_id_conflict':
    case 'suspended':
      return { status: 409, body: result }
    case 'not_found':
      return { status: 404, body: { error: 'card_not_found' } }
    default:
      return { status: 500, body: { error: 'unexpected_result' } }
  }
}
