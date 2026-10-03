import { useCallback, useEffect, useState } from 'react'
import { getSummary, setNewPausedToday, type Summary } from '../lib/api'
import { fmtTime } from '../lib/useOnline'

export function Today({
  onStudy,
  onAdd,
  onImport,
}: {
  onStudy: (extra?: number) => void
  onAdd: () => void
  onImport: () => void
}) {
  const [s, setS] = useState<Summary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => getSummary().then(setS, (e) => setErr(String(e.message ?? e))), [])
  useEffect(() => {
    load()
  }, [load])

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

  const newLeft = s.new_paused_today ? 0 : Math.max(s.daily_new_limit - s.new_learned_today, 0)
  const canStudy = s.due_reviews > 0 || (newLeft > 0 && s.unlearned_total > 0)
  const limitReached = !s.new_paused_today && newLeft === 0 && s.unlearned_total > 0

  return (
    <section className="stack">
      <div className="stats">
        <div className="stat">
          <span className="num">{s.due_reviews}</span>
          <span className="label">오늘 복습</span>
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
          <span className="label">오늘 신규 학습 / 목표</span>
        </div>
        <div className="stat">
          <span className="num">{s.unlearned_total}</span>
          <span className="label">미학습</span>
        </div>
      </div>
      {s.due_reviews === 0 && s.next_due_at && <p className="muted">다음 복습: {fmtTime(s.next_due_at)}</p>}

      <button className="primary big" onClick={() => onStudy()} disabled={!canStudy}>
        {s.due_reviews > 0 ? `복습 ${s.due_reviews}개${newLeft && s.unlearned_total ? ` + 신규 최대 ${newLeft}개` : ''}` : newLeft && s.unlearned_total ? `새 표현 학습 (최대 ${newLeft}개)` : '지금 학습할 카드 없음'}
      </button>
      {limitReached && (
        <div className="notice">
          오늘 신규 목표를 채웠어요.{' '}
          <button className="link" onClick={() => onStudy(5)}>신규 5개 더 학습하기</button>
        </div>
      )}
      {(s.overdue_reviews > 0 || s.new_paused_today) && (
        <button className="secondary" onClick={togglePause} disabled={busy}>
          {s.new_paused_today ? '오늘 신규 학습 다시 하기' : '오늘 신규 학습 쉬기 (복습만)'}
        </button>
      )}
      <div className="row">
        <button className="secondary" onClick={onAdd}>표현 추가</button>
        <button className="secondary" onClick={onImport}>CSV 가져오기</button>
      </div>
    </section>
  )
}
