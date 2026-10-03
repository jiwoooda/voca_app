// Supabase Edge Function: POST /functions/v1/review
// 요청: { card_id, rating, expected_card_version, request_id, response_ms? }
// 사용자 JWT로 인증하고, 서버 시각으로 FSRS를 계산한 뒤 apply_review 트랜잭션으로 저장한다.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { handleReview, type ReviewDb } from '../_shared/review-handler.ts'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! // 서버 환경변수에만 존재
const allowedOrigin = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

const cors = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: authError } = await userClient.auth.getUser()
  if (authError || !userData.user) return json(401, { error: 'not_authenticated' })
  const userId = userData.user.id

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const db: ReviewDb = {
    async getCard(uid, cardId) {
      const { data, error } = await admin.from('cards').select('*').eq('id', cardId).eq('user_id', uid).maybeSingle()
      if (error) throw error
      return data
    },
    async getDesiredRetention(uid) {
      const { data, error } = await admin.from('user_settings').select('desired_retention').eq('user_id', uid).maybeSingle()
      if (error) throw error
      return data ? Number(data.desired_retention) : 0.9
    },
    async applyReview(args) {
      const { data, error } = await admin.rpc('apply_review', args)
      if (error) throw error
      return data as Record<string, unknown>
    },
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  try {
    const res = await handleReview(db, userId, body)
    return json(res.status, res.body)
  } catch (e) {
    console.error(e)
    return json(500, { error: 'server_error' })
  }
})
