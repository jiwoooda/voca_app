import { useEffect, useState } from 'react'
import { getSummary, type Summary } from '../lib/api'
import { fmtTime } from '../lib/useOnline'

export function Today({ onStudy, onAdd }: { onStudy: () => void; onAdd: () => void }) {
  const [s, setS] = useState<Summary | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getSummary().then(setS, (e) => setErr(String(e.message ?? e)))
  }, [])

  if (err) return <p className="notice error">불러오지 못했어요: {err}</p>
  if (!s) return <p className="muted">불러오는 중…</p>

  return (
    <section className="stack">
      <div className="stats">
        <div className="stat">
          <span className="num">{s.due_reviews}</span>
          <span className="label">오늘 복습</span>
        </div>
        <div className="stat">
          <span className="num">{s.overdue_reviews}</span>
          <span className="label">기한 지남</span>
        </div>
        <div className="stat">
          <span className="num">{s.new_learned_today}</span>
          <span className="label">오늘 새로 학습</span>
        </div>
        <div className="stat">
          <span className="num">{s.unlearned_total}</span>
          <span className="label">미학습</span>
        </div>
      </div>
      {s.due_reviews === 0 && s.next_due_at && <p className="muted">다음 복습: {fmtTime(s.next_due_at)}</p>}
      <button className="primary big" onClick={onStudy} disabled={s.due_reviews === 0 && s.unlearned_total === 0}>
        학습 시작
      </button>
      <button className="secondary big" onClick={onAdd}>
        표현 추가
      </button>
    </section>
  )
}
