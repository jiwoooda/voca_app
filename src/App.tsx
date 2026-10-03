import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { configured, supabase } from './lib/supabase'
import { ensureSetup } from './lib/api'
import { Login } from './screens/Login'
import { Today } from './screens/Today'
import { AddItem } from './screens/AddItem'
import { Study } from './screens/Study'

type View = { name: 'today' } | { name: 'add' } | { name: 'study'; firstCardId?: string }

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [view, setView] = useState<View>({ name: 'today' })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) return setReady(false)
    ensureSetup().then(
      () => setReady(true),
      (e) => setSetupError((e as Error).message),
    )
  }, [session?.user.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!configured)
    return (
      <main className="screen narrow">
        <p className="notice error">VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 설정되지 않았어요.</p>
      </main>
    )
  if (session === undefined) return null
  if (!session) return <Login />
  if (setupError) return <main className="screen narrow"><p className="notice error">초기화 실패: {setupError}</p></main>
  if (!ready) return <main className="screen narrow"><p className="muted">불러오는 중…</p></main>

  return (
    <main className="screen">
      <header className="top">
        <button className="brand link" onClick={() => setView({ name: 'today' })}>
          표현 노트
        </button>
        <button className="link small" onClick={() => supabase.auth.signOut()}>
          로그아웃
        </button>
      </header>
      {view.name === 'today' && (
        <Today onStudy={() => setView({ name: 'study' })} onAdd={() => setView({ name: 'add' })} />
      )}
      {view.name === 'add' && (
        <AddItem
          onDone={() => setView({ name: 'today' })}
          onStudyNow={(id) => setView({ name: 'study', firstCardId: id })}
        />
      )}
      {view.name === 'study' && <Study firstCardId={view.firstCardId} onExit={() => setView({ name: 'today' })} />}
    </main>
  )
}
