import { useState, type FormEvent } from 'react'
import { addPersonalItem, findDuplicates, type NewItem } from '../lib/api'

type Dup = Awaited<ReturnType<typeof findDuplicates>>

const EMPTY: NewItem = { expression: '', meaning: '', example: '', example_translation: '', note: '', source: '' }

export function AddItem({ onDone, onStudyNow }: { onDone: () => void; onStudyNow: (cardId: string) => void }) {
  const [v, setV] = useState<NewItem>(EMPTY)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [dups, setDups] = useState<Dup | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [then, setThen] = useState<'save' | 'study'>('save')

  const set = (k: keyof NewItem) => (e: { target: { value: string } }) => {
    setV({ ...v, [k]: e.target.value })
    setDups(null) // 내용이 바뀌면 중복 확인을 다시 한다
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!v.expression.trim() || !v.meaning.trim()) return setErr('영어 표현과 뜻은 필수예요.')
    setBusy(true)
    setErr(null)
    setSaved(null)
    try {
      if (dups === null) {
        const found = await findDuplicates(v.expression)
        if (found.length > 0) {
          setDups(found) // 사용자 확인 후 다시 제출
          return
        }
      }
      const cardId = await addPersonalItem(requestId, v)
      setRequestId(crypto.randomUUID())
      setDups(null)
      if (then === 'study') return onStudyNow(cardId)
      setSaved(v.expression)
      setV(EMPTY)
    } catch (e) {
      // 입력 내용은 유지. 같은 requestId로 다시 저장해도 중복 생성되지 않는다.
      setErr(navigator.onLine ? `저장하지 못했어요: ${(e as Error).message}` : '인터넷 연결이 없어 저장하지 못했어요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        영어 표현 *
        <input value={v.expression} onChange={set('expression')} autoCapitalize="none" required />
      </label>
      <label>
        한국어 뜻·상황 *
        <textarea rows={2} value={v.meaning} onChange={set('meaning')} required />
      </label>
      <label>
        예문
        <textarea rows={2} value={v.example} onChange={set('example')} autoCapitalize="sentences" />
      </label>
      <label>
        예문 해석
        <input value={v.example_translation} onChange={set('example_translation')} />
      </label>
      <label>
        메모
        <input value={v.note} onChange={set('note')} />
      </label>
      <label>
        출처
        <input value={v.source} onChange={set('source')} />
      </label>

      {dups && (
        <div className="notice">
          <strong>비슷한 표현이 이미 있어요.</strong>
          <ul>
            {dups.map((d) => (
              <li key={d.item_id}>
                {d.expression} — {d.meaning} <span className="muted">({d.collection_name})</span>
              </li>
            ))}
          </ul>
          뜻이 다르면 그대로 저장하세요. 아래 버튼을 다시 누르면 저장됩니다.
        </div>
      )}
      {err && <p className="notice error">{err}</p>}
      {saved && <p className="notice ok">“{saved}” 저장했어요.</p>}

      <div className="row">
        <button className="secondary" disabled={busy} onClick={() => setThen('save')}>
          {busy && then === 'save' ? '저장 중…' : '저장'}
        </button>
        <button className="primary" disabled={busy} onClick={() => setThen('study')}>
          {busy && then === 'study' ? '저장 중…' : '저장하고 지금 학습'}
        </button>
      </div>
      <button type="button" className="link" onClick={onDone}>
        닫기
      </button>
    </form>
  )
}
