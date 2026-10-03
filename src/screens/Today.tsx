import { useCallback, useEffect, useState } from 'react'
import { getSummary, setNewPausedToday, type StudyMode, type Summary } from '../lib/api'
import { fmtTime } from '../lib/useOnline'

const MODES: { value: StudyMode; label: string }[] = [
  { value: null, label: '섞어서' },
  { value: 'expression_to_meaning', label: '영어 → 뜻' },
  { value: 'meaning_to_expression', label: '뜻 → 영어' },
]
const MODE_KEY = 'study-mode'

function loadMode(): StudyMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'expression_to_meaning' || v === 'meaning_to_expression' ? v : null
  } catch {
    return null
  }
}

export function Today({
  onStudy,
  onAdd,
  onImport,
}: {
  onStudy: (extra: number, mode: StudyMode) => void
  onAdd: () => void
  onImport: () => void
}) {
  const [s, setS] = useState<Summary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<StudyMode>(loadMode)

  const load = useCallback(() => getSummary().then(setS, (e) => setErr(String(e.message ?? e))), [])
  useEffect(() => {
    load()
  }, [load])

  function pick(m: StudyMode) {
    setMode(m)
    try {
      if (m) localStorage.setItem(MODE_KEY, m)
      else localStorage.removeItem(MODE_KEY)
    } catch {
      /* 저장 못 해도 동작에는 문제 없음 */
    }
  }

  async function togglePause() {
    if (!s) return
    setBusy(true)
    try {
      await setNewPausedToday(!s.new_paused_today)
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (err) return <p className="notice error">불러오지 못했어요: {err}</p>
  if (!s) return <p className="muted">불러오는 중…</p>

  const due = mode ? (s.due_by_direction?.[mode] ?? 0) : s.due_reviews
  const newLeft = s.new_paused_today ? 0 : Math.max(s.daily_new_limit - s.new_learned_today, 0)
  const limitReached = !s.new_paused_today && newLeft === 0 && s.unlearned_total > 0
  const label =
    due > 0
      ? `복습 ${due}개${newLeft && s.unlearned_total ? ` + 새 단어 최대 ${newLeft}개` : ''}`
      : newLeft && s.unlearned_total
        ? `학습 시작 (새 단어 최대 ${newLeft}개)`
        : '학습 시작'

  return (
    <section className="stack">
      <div className="stats">
        <div className="stat">
          <span className="num">{s.due_reviews}</span>
          <span className="label">
            오늘 복습 <small>(영→뜻 {s.due_by_direction?.expression_to_meaning ?? 0} · 뜻→영 {s.due_by_direction?.meaning_to_expression ?? 0})</small>
          </span>
        </div>
        <div className="stat">
          <span className="num">{s.overdue_reviews}</span>
          <span className="label">기한 지난 복습</span>
        </div>
        <div className="stat">
          <span className="num">
            {s.new_learned_today}
            <small> / {s.new_paused_today ? '쉼' : s.daily_new_limit}</small>
          </span>
          <span className="label">오늘 새 단어 / 목표</span>
        </div>
        <div className="stat">
          <span className="num">{s.unlearned_total}</span>
          <span className="label">아직 안 배운 단어</span>
        </div>
      </div>
      {s.due_reviews === 0 && s.next_due_at && <p className="muted">다음 복습: {fmtTime(s.next_due_at)}</p>}

      <div className="segmented" role="radiogroup" aria-label="학습 방향">
        {MODES.map((m) => (
          <button
            key={m.label}
            role="radio"
            aria-checked={mode === m.value}
            className={mode === m.value ? 'on' : ''}
            onClick={() => pick(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <button className="primary big" onClick={() => onStudy(0, mode)}>
        {label}
      </button>
      {limitReached && (
        <div className="notice">
          오늘 새 단어 목표를 채웠어요.{' '}
          <button className="link" onClick={() => onStudy(5, mode)}>새 단어 5개 더 학습하기</button>
        </div>
      )}
      {(s.overdue_reviews > 0 || s.new_paused_today) && (
        <button className="secondary" onClick={togglePause} disabled={busy}>
          {s.new_paused_today ? '오늘 새 단어 다시 학습하기' : '오늘 새 단어 쉬기 (복습만)'}
        </button>
      )}
      <div className="row">
        <button className="secondary" onClick={onAdd}>표현 추가</button>
        <button className="secondary" onClick={onImport}>CSV 가져오기</button>
      </div>
    </section>
  )
}
