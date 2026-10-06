// 기기 내장 음성(Web Speech API)으로 영어 읽기. iPhone Safari·Chrome·Edge 지원.
export const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

let voice: SpeechSynthesisVoice | null = null

function pickVoice() {
  const voices = window.speechSynthesis.getVoices()
  const en = voices.filter((v) => v.lang?.toLowerCase().startsWith('en'))
  voice =
    en.find((v) => v.lang === 'en-US' && /samantha|google us|aria|jenny|natural/i.test(v.name)) ??
    en.find((v) => v.lang === 'en-US') ??
    en[0] ??
    null
}

if (canSpeak) {
  pickVoice()
  window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice)
}

export function speak(text: string, rate = 0.9) {
  if (!canSpeak || !text) return
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  if (voice) u.voice = voice
  u.rate = rate
  synth.speak(u)
}
