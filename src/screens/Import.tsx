import { useState } from 'react'
import { findExistingDuplicates, importItems, type ImportResult } from '../lib/api'
import { normalize, parseCsv, type ParsedCsv } from '../lib/csv'

type Existing = Awaited<ReturnType<typeof findExistingDuplicates>>

export function Import({ onDone }: { onDone: () => void }) {
  const [fileName, setFileName] = useState('')
  const [name, setName] = useState('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [existing, setExisting] = useState<Existing>([])
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  async function onFile(file: File | undefined) {
    if (!file) return
    setErr(null)
    setResult(null)
    setParsed(null)
    setExisting([])
    if (/\.(xlsx?|numbers)$/i.test(file.name)) {
      setErr('엑셀 파일은 바로 읽을 수 없어요. 엑셀에서 "다른 이름으로 저장 → CSV UTF-8"로 저장한 뒤 올려 주세요.')
      return
    }
    setFileName(file.name)
    setName(file.name.replace(/\.csv$/i, '').slice(0, 100))
    setRequestId(crypto.randomUUID())
    const p = parseCsv(await file.text())
    setParsed(p)
    if (!p.fatal && p.valid.length) {
      setBusy(true)
      try {
        setExisting(await findExistingDuplicates([...new Set(p.valid.map((r) => r.expression))]))
      } catch (e) {
        setErr(`기존 단어와 비교하지 못했어요: ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    }
  }

  async function confirm() {
    if (!parsed || !parsed.valid.length) return
    setBusy(true)
    setErr(null)
    try {
      // 실패 후 다시 눌러도 같은 requestId라 중복 생성되지 않는다
      setResult(await importItems(requestId, name.trim() || fileName, parsed.valid))
      setParsed(null)
    } catch (e) {
      setErr(navigator.onLine ? `가져오지 못했어요: ${(e as Error).message}` : '인터넷 연결이 없어 가져오지 못했어요.')
    } finally {
      setBusy(false)
    }
  }

  const existingSet = new Set(existing.map((e) => e.normalized))
  const existingRows = parsed?.valid.filter((r) => existingSet.has(normalize(r.expression))) ?? []

  if (result)
    return (
      <section className="stack">
        <p className="notice ok">
          <strong>{result.inserted}개</strong>를 ‘{name || fileName}’ 모음집에 넣었어요.
          {result.duplicate_request && ' (이미 처리된 요청이라 다시 만들지 않았어요)'}
        </p>
        {result.errors.length > 0 && (
          <div className="notice error">
            서버에서 거절한 행 {result.errors.length}개
            <ul>{result.errors.slice(0, 50).map((e) => <li key={e.row}>{e.row}행: {e.reason}</li>)}</ul>
          </div>
        )}
        <p className="muted">모두 ‘미학습’ 상태예요. 하루 신규 학습량만큼만 학습 목록에 나와요.</p>
        <button className="primary big" onClick={onDone}>확인</button>
      </section>
    )

  return (
    <section className="stack">
      <h2 className="title">CSV 가져오기</h2>
      <p className="muted small">
        첫 줄 열 이름: <code>expression,meaning,example,example_translation,note,source</code>
        <br />필수는 expression, meaning. 엑셀은 “CSV UTF-8”로 저장해서 올려 주세요.
      </p>
      <label className="file">
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
      </label>

      {parsed?.fatal && <p className="notice error">{parsed.fatal}</p>}

      {parsed && !parsed.fatal && (
        <>
          <label>
            모음집 이름
            <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="stats">
            <div className="stat"><span className="num">{parsed.valid.length}</span><span className="label">가져올 행</span></div>
            <div className="stat"><span className="num">{parsed.errors.length}</span><span className="label">오류 행 (제외)</span></div>
            <div className="stat"><span className="num">{parsed.inFileDuplicates.length}</span><span className="label">파일 안 중복</span></div>
            <div className="stat"><span className="num">{busy ? '…' : existingRows.length}</span><span className="label">기존과 중복 후보</span></div>
          </div>
          {parsed.ignoredColumns.length > 0 && (
            <p className="muted small">무시하는 열: {parsed.ignoredColumns.join(', ')}</p>
          )}
          {parsed.errors.length > 0 && (
            <details className="notice error" open={parsed.errors.length <= 10}>
              <summary>오류 행 {parsed.errors.length}개</summary>
              <ul>{parsed.errors.slice(0, 200).map((e) => <li key={e.row}>{e.row}행: {e.reason}</li>)}</ul>
            </details>
          )}
          {parsed.inFileDuplicates.length > 0 && (
            <details className="notice">
              <summary>파일 안 중복 {parsed.inFileDuplicates.length}건 (모두 가져옴)</summary>
              <ul>{parsed.inFileDuplicates.slice(0, 200).map((d) => <li key={d.normalized}>{d.normalized}: {d.rows.join(', ')}행</li>)}</ul>
            </details>
          )}
          {existingRows.length > 0 && (
            <details className="notice">
              <summary>이미 있는 표현과 같은 행 {existingRows.length}개 (뜻이 다를 수 있어 모두 가져옴)</summary>
              <ul>{existingRows.slice(0, 200).map((r) => <li key={r.row}>{r.row}행: {r.expression} — {r.meaning}</li>)}</ul>
            </details>
          )}
          <details className="notice">
            <summary>미리보기 (앞 5행)</summary>
            <ul>{parsed.valid.slice(0, 5).map((r) => <li key={r.row}>{r.expression} — {r.meaning}</li>)}</ul>
          </details>
          <button className="primary big" disabled={busy || parsed.valid.length === 0} onClick={confirm}>
            {busy ? '처리 중…' : `${parsed.valid.length}개 가져오기`}
          </button>
        </>
      )}
      {err && <p className="notice error">{err}</p>}
      <button className="link" onClick={onDone}>닫기</button>
    </section>
  )
}
