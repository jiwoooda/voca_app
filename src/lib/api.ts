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
  daily_new_limit: number
  new_paused_today: boolean
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
 * 오늘 학습 목록 (서버 계산): 기한이 된 복습 → 신규(개인 표현 우선, 일일 한도 내).
 * extra: 한도 도달 후 사용자가 직접 고른 추가 신규 수. firstCardId: '지금 학습'으로 고른 카드.
 */
export async function loadQueue(firstCardId?: string, extra = 0): Promise<StudyCard[]> {
  const ids = (check(await supabase.rpc('get_study_queue', { p_extra: extra })) as { card_id: string }[]).map(
    (r) => r.card_id,
  )
  if (firstCardId && !ids.includes(firstCardId)) ids.unshift(firstCardId)
  else if (firstCardId) ids.splice(0, 0, ...ids.splice(ids.indexOf(firstCardId), 1))
  const cards: StudyCard[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows = check(await supabase.from('cards').select(CARD_SELECT).in('id', chunk)) as unknown as StudyCard[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of chunk) {
      const c = byId.get(id)
      // '지금 학습'으로 고른 카드가 이미 학습된 경우 등은 제외
      if (c && !(id === firstCardId && c.introduced_at && new Date(c.due_at) > new Date())) cards.push(c)
    }
  }
  return cards
}

export async function setNewPausedToday(paused: boolean) {
  check(await supabase.rpc('set_new_paused_today', { p_paused: paused }))
}

export async function findExistingDuplicates(expressions: string[]) {
  const out: { normalized: string; expression: string; meaning: string; collection_name: string }[] = []
  for (let i = 0; i < expressions.length; i += 500) {
    const part = check(
      await supabase.rpc('find_existing_duplicates', { p_expressions: expressions.slice(i, i + 500) }),
    ) as typeof out
    out.push(...part)
  }
  return out
}

export interface ImportResult {
  collection_id: string
  inserted: number
  errors: { row: number; reason: string }[]
  duplicate_request?: boolean
}

export async function importItems(requestId: string, collectionName: string, rows: unknown[]): Promise<ImportResult> {
  return check(
    await supabase.rpc('import_items', { p_request_id: requestId, p_collection_name: collectionName, p_rows: rows }),
  ) as ImportResult
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

export interface Settings {
  daily_new_limit: number
  personal_new_limit: number
  desired_retention: number
}

export async function getSettings(): Promise<Settings> {
  const s = check(await supabase.from('user_settings').select('daily_new_limit, personal_new_limit, desired_retention').single()) as Settings
  return { ...s, desired_retention: Number(s.desired_retention) }
}

export async function saveSettings(s: Settings) {
  check(
    await supabase.rpc('update_my_settings', {
      p_daily_new_limit: s.daily_new_limit,
      p_personal_new_limit: s.personal_new_limit,
      p_desired_retention: s.desired_retention,
    }),
  )
}

export interface Collection {
  id: string
  name: string
  kind: 'personal' | 'imported'
  is_active: boolean
}

export async function listCollections(): Promise<Collection[]> {
  return check(await supabase.from('collections').select('id, name, kind, is_active').order('created_at')) as Collection[]
}

export async function setCollectionActive(id: string, active: boolean) {
  check(await supabase.rpc('set_collection_active', { p_collection_id: id, p_active: active }))
}
