import { supabase } from './supabase'

export interface Item {
  id: string
  expression: string
  meaning: string
  example: string | null
  example_translation: string | null
  note: string | null
  source: string | null
}

export interface StudyCard {
  id: string
  version: number
  state: number
  due_at: string
  introduced_at: string | null
  items: Item
}

export interface Summary {
  due_reviews: number
  overdue_reviews: number
  new_learned_today: number
  unlearned_total: number
  next_due_at: string | null
}

export class ApiError extends Error {
  code: string
  status?: number
  constructor(code: string, status?: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new ApiError(res.error.message, Number(res.error.code) || undefined)
  return res.data
}

export async function ensureSetup() {
  check(await supabase.rpc('ensure_user_setup'))
}

export async function getSummary(): Promise<Summary> {
  return check(await supabase.rpc('today_summary')) as Summary
}

export async function findDuplicates(expression: string) {
  return check(await supabase.rpc('find_duplicate_candidates', { p_expression: expression })) as {
    item_id: string
    expression: string
    meaning: string
    collection_name: string
  }[]
}

export interface NewItem {
  expression: string
  meaning: string
  example?: string
  example_translation?: string
  note?: string
  source?: string
}

/** 항목 + 미학습 카드 생성. 반환값은 카드 id */
export async function addPersonalItem(requestId: string, v: NewItem): Promise<string> {
  return check(
    await supabase.rpc('add_personal_item', {
      p_request_id: requestId,
      p_expression: v.expression,
      p_meaning: v.meaning,
      p_example: v.example || null,
      p_example_translation: v.example_translation || null,
      p_note: v.note || null,
      p_source: v.source || null,
    }),
  ) as string
}

const CARD_SELECT = 'id, version, state, due_at, introduced_at, items(id, expression, meaning, example, example_translation, note, source)'

/**
 * 1단계 학습 목록: 기한이 된 복습 → 미학습 카드 순.
 * (일일 신규 한도·개인 표현 배정은 2단계에서 서버 함수로 옮긴다.)
 */
export async function loadQueue(firstCardId?: string): Promise<StudyCard[]> {
  const now = new Date().toISOString()
  const due = check(
    await supabase.from('cards').select(CARD_SELECT).not('introduced_at', 'is', null).is('suspended_at', null)
      .lte('due_at', now).order('due_at').limit(200),
  ) as unknown as StudyCard[]
  const fresh = check(
    await supabase.from('cards').select(CARD_SELECT).is('introduced_at', null).is('suspended_at', null)
      .order('created_at').limit(50),
  ) as unknown as StudyCard[]
  let queue = [...due, ...fresh]
  if (firstCardId) {
    const first = queue.find((c) => c.id === firstCardId)
    if (first) queue = [first, ...queue.filter((c) => c.id !== firstCardId)]
  }
  return queue
}

export async function getCard(id: string): Promise<StudyCard> {
  return check(await supabase.from('cards').select(CARD_SELECT).eq('id', id).single()) as unknown as StudyCard
}

export interface ReviewResult {
  status: 'ok' | 'duplicate'
  event_id: string
  card: { id: string; version: number; due_at: string; state: number }
}

/** 평가 저장. 서버가 FSRS를 계산한다. 같은 requestId로 재시도해도 한 번만 기록된다. */
export async function submitReview(args: {
  cardId: string
  rating: 1 | 2 | 3 | 4
  version: number
  requestId: string
  responseMs?: number
}): Promise<ReviewResult> {
  const { data, error } = await supabase.functions.invoke('review', {
    body: {
      card_id: args.cardId,
      rating: args.rating,
      expected_card_version: args.version,
      request_id: args.requestId,
      response_ms: args.responseMs,
    },
  })
  if (error) {
    const ctx = (error as { context?: Response }).context
    let code = 'network_error'
    let status: number | undefined
    if (ctx && typeof ctx.status === 'number') {
      status = ctx.status
      try {
        const body = await ctx.json()
        code = body.status ?? body.error ?? code
      } catch {
        code = 'server_error'
      }
    }
    throw new ApiError(code, status)
  }
  return data as ReviewResult
}

export async function revertReview(eventId: string): Promise<{ status: string }> {
  return check(await supabase.rpc('revert_review', { p_event_id: eventId })) as { status: string }
}
