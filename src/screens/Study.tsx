import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  getCard,
  getSummary,
  loadQueue,
  revertReview,
  setItemPhonetic,
  submitReview,
  type StudyCard,
  type StudyMode,
} from '../lib/api'
import { lookupPhonetic } from '../lib/phonetic'
import { canSpeak, speak } from '../lib/speech'
import { fmtTime, useOnline } from '../lib/useOnline'

const RATINGS = [
  { value: 1, label: '모름', cls: 'again' },
  { value: 2, label: '어렵게 기억', cls: 'hard' },
  { value: 3, label: '기억남', cls: 'good' },
  { value: 4, label: '쉽게 기억', cls: 'easy' },
] as const

export function Study({
  firstCardId,
  extra = 0,
  mode = null,
  onExit,
}: {
  firstCardId?: string
  extra?: number
  mode?: StudyMode
  onExit: () => void
}) {
  const online = useOnline()
  const [queue, setQueue] = useState<StudyCard[] | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [nextDue, setNextDue] = useState<string | null>(null)
  const [last, setLast] = useState<{ eventId: string; cardId: string; expression: string } | null>(null)
  const [done, setDone] = useState(0) // 이번 학습에서 평가한 수
  const [phonetics, setPhonetics] = useState<Record<string, string | null>>({})
  const requestId = useRef<string>(crypto.randomUUID()) // 같은 카드의 재시도는 같은 ID 사용
  const shownAt = useRef<number>(Date.now())

  const reload = useCallback(async (first?: string) => {
    try {
      const q = await loadQueue(first, extra, mode)
      setQueue(q)
      if (q.length === 0) setNextDue((await getSummary()).next_due_at)
    } catch (e) {
      setError(`불러오지 못했어요: ${(e as Error).message}`)
      setQueue((prev) => prev ?? [])
    }
  }, [extra, mode])

  useEffect(() => {
    reload(firstCardId)
  }, [reload, firstCardId])

  const card = queue?.[0]

  // 새 카드가 화면에 올라올 때마다 초기화
  useEffect(() => {
    setRevealed(false)
    requestId.current = crypto.randomUUID()
    shownAt.current = Date.now()
  }, [card?.id, card?.version])

  // 발음 기호가 없고 아직 조회하지 않은 단어는 사전에서 가져와 저장
  const item = card?.items
  useEffect(() => {
    if (!item || item.phonetic || item.phonetic_checked_at || item.id in phonetics) return
    let cancelled = false
    lookupPhonetic(item.expression).then(
      async (p) => {
        if (cancelled) return
        setPhonetics((m) => ({ ...m, [item.id]: p }))
        try {
          await setItemPhonetic(item.id, p)
        } catch {
          /* 저장 실패해도 학습에는 영향 없음 */
        }
      },
      () => {
        /* 네트워크 오류: 다음에 다시 시도 */
      },
    )
    return () => {
      cancelled = true
    }
  }, [item, phonetics])
  const phonetic = item ? (item.phonetic ?? phonetics[item.id] ?? null) : null

  // 남은 카드가 없으면 다음 복습 시각에 다시 불러온다 (최대 30분 간격 확인)
  useEffect(() => {
    if (!queue || queue.length > 0 || !nextDue) return
    const wait = Math.min(Math.max(new Date(nextDue).getTime() - Date.now() + 1000, 1000), 30 * 60_000)
    const t = setTimeout(() => reload(), wait)
    return () => clearTimeout(t)
  }, [queue, nextDue, reload])

  async function rate(rating: 1 | 2 | 3 | 4) {
    if (!card || !revealed || saving) return
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const res = await submitReview({
        cardId: card.id,
        rating,
        version: card.version,
        requestId: requestId.current,
        responseMs: Date.now() - shownAt.current,
      })
      setLast({ eventId: res.event_id, cardId: card.id, expression: card.items.expression })
      setDone((d) => d + 1)
      // 저장 성공 후에만 다음 카드로
      const rest = queue!.slice(1)
      if (rest.length === 0) await reload()
      else setQueue(rest)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'unknown'
      if (code === 'version_conflict' || code === 'suspended') {
        setInfo('다른 기기에서 이 카드가 먼저 평가됐어요. 최신 상태로 다시 불러옵니다.')
        await reload()
      } else if (!navigator.onLine || code === 'network_error') {
        setError('인터넷 연결이 없어 저장하지 못했어요. 연결 후 다시 눌러 주세요.')
      } else {
        setError(`저장하지 못했어요 (${code}). 다시 눌러 주세요.`)
      }
      // 실패 시 현재 카드와 정답 공개 상태 유지
    } finally {
      setSaving(false)
    }
  }

  async function undo() {
    if (!last || saving) return
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const r = await revertReview(last.eventId)
      if (r.status === 'ok') {
        const restored = await getCard(last.cardId)
        setQueue((q) => [restored, ...(q ?? []).filter((c) => c.id !== restored.id)])
        setLast(null)
        setDone((d) => Math.max(d - 1, 0))
      } else if (r.status === 'version_conflict') {
        setInfo('그 뒤에 다른 평가가 있어서 취소할 수 없어요.')
        setLast(null)
      } else {
        setInfo('이미 취소됐거나 찾을 수 없는 평가예요.')
        setLast(null)
      }
    } catch (e) {
      setError(`취소하지 못했어요: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!queue) return <p className="muted">불러오는 중…</p>

  return (
    <section className="stack">
      <div className="progress" aria-label="진행 상황">
        <div className="progress-text">
          <span>완료 {done}</span>
          <span>남은 카드 {queue.length}</span>
        </div>
        <div className="bar">
          <div style={{ width: `${done + queue.length ? (done / (done + queue.length)) * 100 : 100}%` }} />
        </div>
      </div>
      {!online && <p className="notice error">오프라인 상태예요. 평가를 저장할 수 없어요.</p>}
      {info && <p className="notice">{info}</p>}

      {card ? (
        <div className="card">
          <p className="tag">
            {card.introduced_at ? '복습' : '새 카드'} · {card.prompt_type === 'expression_to_meaning' ? '영어 → 뜻' : '뜻 → 영어'}
          </p>
          {card.prompt_type === 'expression_to_meaning' ? (
            <Expression text={card.items.expression} phonetic={phonetic} />
          ) : (
            <p className="prompt">{card.items.meaning}</p>
          )}
          {revealed ? (
            <div className="answer">
              {card.prompt_type === 'expression_to_meaning' ? (
                <p className="prompt">{card.items.meaning}</p>
              ) : (
                <Expression text={card.items.expression} phonetic={phonetic} autoPlay />
              )}
              {card.items.example && (
                <p className="example">
                  {card.items.example}
                  {canSpeak && (
                    <button className="speak small-speak" aria-label="예문 듣기" onClick={() => speak(card.items.example!)}>
                      🔊
                    </button>
                  )}
                </p>
              )}
              {card.items.example_translation && <p className="muted">{card.items.example_translation}</p>}
              {card.items.note && <p className="note">{card.items.note}</p>}
            </div>
          ) : (
            <button className="primary big" onClick={() => setRevealed(true)}>
              정답 보기
            </button>
          )}
        </div>
      ) : (
        <div className="card empty">
          <p>지금 학습할 카드가 없어요.</p>
          {nextDue && <p className="muted">다음 학습 가능: {fmtTime(nextDue)}</p>}
          <button className="secondary" onClick={() => reload()}>
            새로고침
          </button>
        </div>
      )}

      {card && revealed && (
        <>
          <p className="hint">정답을 보고 알겠다고 느껴도, 떠올리지 못했다면 ‘모름’을 선택하세요.</p>
          <div className="ratings">
            {RATINGS.map((r) => (
              <button key={r.value} className={`rating ${r.cls}`} disabled={saving} onClick={() => rate(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="status" aria-live="polite">
        {saving ? '저장 중…' : error ? '' : last ? `“${last.expression}” 저장됨` : ''}
      </p>
      {error && <p className="notice error">{error}</p>}

      <div className="row">
        <button className="secondary" onClick={undo} disabled={!last || saving}>
          직전 평가 취소
        </button>
        <button className="link" onClick={onExit}>
          나가기
        </button>
      </div>
    </section>
  )
}

function Expression({ text, phonetic, autoPlay = false }: { text: string; phonetic: string | null; autoPlay?: boolean }) {
  // 뜻→영어 카드는 정답을 열 때 자동으로 한 번 읽어 준다
  useEffect(() => {
    if (autoPlay) speak(text)
  }, [autoPlay, text])
  return (
    <div className="expression-row">
      <p className="expression">{text}</p>
      {canSpeak && (
        <button className="speak" aria-label="발음 듣기" onClick={() => speak(text)}>
          🔊
        </button>
      )}
      {phonetic && <p className="phonetic">{phonetic}</p>}
    </div>
  )
}
