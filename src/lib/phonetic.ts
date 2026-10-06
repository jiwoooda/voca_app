// 무료 영어 사전(dictionaryapi.dev)에서 발음 기호 조회.
// 반환: 기호 문자열 / null(사전에 없음). 네트워크 오류는 throw → 다음에 다시 시도.
export async function lookupPhonetic(expression: string): Promise<string | null> {
  const word = expression.trim().toLowerCase()
  if (!word || word.length > 60) return null
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      signal: ctrl.signal,
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`dictionary ${res.status}`)
    const data = (await res.json()) as { phonetic?: string; phonetics?: { text?: string }[] }[]
    for (const entry of Array.isArray(data) ? data : []) {
      const p = entry.phonetic || entry.phonetics?.find((x) => x.text)?.text
      if (p) return p.trim().slice(0, 200)
    }
    return null
  } finally {
    clearTimeout(t)
  }
}
