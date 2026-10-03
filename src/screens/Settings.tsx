import { useEffect, useState } from 'react'
import { getSettings, listCollections, saveSettings, setCollectionActive, type Collection, type Settings as S } from '../lib/api'

export function Settings({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<S | null>(null)
  const [cols, setCols] = useState<Collection[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    Promise.all([getSettings(), listCollections()]).then(
      ([a, b]) => {
        setS(a)
        setCols(b)
      },
      (e) => setMsg({ ok: false, text: (e as Error).message }),
    )
  }, [])

  async function save() {
    if (!s) return
    setBusy(true)
    setMsg(null)
    try {
      await saveSettings(s)
      setMsg({ ok: true, text: '저장했어요.' })
    } catch (e) {
      setMsg({ ok: false, text: `저장하지 못했어요: ${(e as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  async function toggle(c: Collection) {
    try {
      await setCollectionActive(c.id, !c.is_active)
      setCols(cols.map((x) => (x.id === c.id ? { ...x, is_active: !x.is_active } : x)))
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    }
  }

  if (!s) return msg ? <p className="notice error">{msg.text}</p> : <p className="muted">불러오는 중…</p>

  const num = (k: keyof S) => (e: { target: { value: string } }) => setS({ ...s, [k]: Number(e.target.value) })

  return (
    <section className="stack">
      <h2 className="title">설정</h2>
      <label>
        하루 신규 단어 수
        <input type="number" inputMode="numeric" min={0} max={500} value={s.daily_new_limit} onChange={num('daily_new_limit')} />
      </label>
      <label>
        그중 ‘내 표현’ 우선 배정 최대
        <input type="number" inputMode="numeric" min={0} max={500} value={s.personal_new_limit} onChange={num('personal_new_limit')} />
      </label>
      <label>
        학습 방향
        <select value={s.directions} onChange={(e) => setS({ ...s, directions: e.target.value as S['directions'] })}>
          <option value="both">둘 다 (영어→뜻 먼저, 다음 날부터 뜻→영어)</option>
          <option value="expression_to_meaning">영어 보고 뜻 맞추기만</option>
          <option value="meaning_to_expression">뜻 보고 영어 맞추기만</option>
        </select>
      </label>
      <label>
        목표 회상률 ({Math.round(s.desired_retention * 100)}%)
        <input type="range" min={0.7} max={0.97} step={0.01} value={s.desired_retention} onChange={num('desired_retention')} />
      </label>
      <p className="muted small">
        회상률을 높이면 복습이 잦아지고, 낮추면 줄어요. 변경은 이후 평가부터 적용돼요. 신규를 많이 넣으면 몇 주 뒤 복습량이 크게 늘어요.
      </p>
      <button className="primary" onClick={save} disabled={busy}>{busy ? '저장 중…' : '저장'}</button>
      {msg && <p className={`notice ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}

      {cols.some((c) => c.kind === 'imported') && (
        <>
          <h2 className="title">신규 단어를 가져올 모음집</h2>
          <p className="muted small">끈 모음집에서는 새 단어가 나오지 않아요. 이미 학습한 단어의 복습은 계속돼요.</p>
          {cols.filter((c) => c.kind === 'imported').map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={c.is_active} onChange={() => toggle(c)} />
              {c.name}
            </label>
          ))}
        </>
      )}
      <button className="link" onClick={onDone}>닫기</button>
    </section>
  )
}
