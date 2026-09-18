'use client'

import type { QuizSummary, SessionInfo } from '@quiz/protocol'
import {
  ArrowUpIcon,
  ChevronRightIcon,
  EnterIcon,
  InfoCircledIcon,
  PlusCircledIcon,
  RocketIcon,
} from '@radix-ui/react-icons'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { HTTP_URL } from '@/lib/config'
import { AppShell } from './ui/AppShell'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { HowItWorks } from './ui/HowItWorks'
import { Mascot } from './ui/Mascot'
import { Modal } from './ui/Modal'
import { QuizSelect } from './ui/QuizSelect'

export function Home() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([])
  const [definition, setDefinition] = useState('')
  const [live, setLive] = useState<{ sessions: number; players: number } | null>(null)
  const [offline, setOffline] = useState(false)
  const [hostOpen, setHostOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState('')

  useEffect(() => {
    try {
      const saved = localStorage.getItem('quiz:name')
      if (saved) setName(saved)
    } catch {
      /* ignore */
    }
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
    tick()
    const t = setInterval(tick, 15_000)

    fetch(`${HTTP_URL}/api/quizzes`)
      .then((r) => r.json())
      .then((j: { quizzes: QuizSummary[] }) => {
        setQuizzes(j.quizzes)
        if (j.quizzes[0]) setDefinition(j.quizzes[0].id)
      })
      .catch(() => setOffline(true))

    const poll = () =>
      fetch(`${HTTP_URL}/api/sessions`)
        .then((r) => r.json())
        .then((j: { sessions: SessionInfo[] }) =>
          setLive({
            sessions: j.sessions.length,
            players: j.sessions.reduce((a, s) => a + s.participants, 0),
          }),
        )
        .catch(() => undefined)
    poll()
    const p = setInterval(poll, 5_000)
    return () => {
      clearInterval(t)
      clearInterval(p)
    }
  }, [])

  const remember = () => {
    try {
      localStorage.setItem('quiz:name', name.trim())
    } catch {
      /* ignore */
    }
  }

  const join = (e?: React.FormEvent) => {
    e?.preventDefault()
    const c = code.trim().toUpperCase()
    if (!name.trim() || !c) return
    remember()
    router.push(`/quiz/${encodeURIComponent(c)}?name=${encodeURIComponent(name.trim())}`)
  }

  const create = async () => {
    if (!name.trim()) {
      setError('Add your name first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${HTTP_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(definition ? { quizDefinitionId: definition } : {}),
      })
      if (!res.ok) throw new Error(`The server answered ${res.status}.`)
      const info = (await res.json()) as SessionInfo
      remember()
      router.push(
        `/quiz/${encodeURIComponent(info.quizId)}?name=${encodeURIComponent(name.trim())}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canJoin = name.trim().length > 0 && code.trim().length > 0

  return (
    <AppShell
      sidebar={{
        items: [
          { icon: <PlusCircledIcon />, label: 'New session', onSelect: () => setHostOpen(true) },
          {
            icon: <EnterIcon />,
            label: 'Join with code',
            onSelect: () => document.getElementById('code')?.focus(),
          },
        ],
        secondary: [
          {
            icon: <InfoCircledIcon />,
            label: 'How scoring works',
            onSelect: () => setRulesOpen(true),
          },
        ],
        footer: {
          title: 'Quiz 101',
          subtitle: 'Learn how a session works',
          onSelect: () => setRulesOpen(true),
        },
      }}
      topCenter="Vocab Quiz"
      topRight={<Button onClick={() => setHostOpen(true)}>Host a session</Button>}
    >
      <div className="mx-auto my-auto flex w-full max-w-[520px] flex-col items-center gap-5 px-2 pt-10 pb-6 sm:py-6 fade-up">
        <div className="flex flex-col items-center text-center">
          <Mascot size={36} />
          <p className="mt-3 text-[11px] text-mist">
            {clock}
            {live
              ? ` · ${live.players} player${live.players === 1 ? '' : 's'} online · ${live.sessions} session${live.sessions === 1 ? '' : 's'}`
              : ''}
          </p>
          <h1 className="mt-1.5 text-[26px] font-bold tracking-[-0.02em]">Learn words, live.</h1>
          <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-ink-2">
            Join a session with its code, answer fast, and watch the leaderboard move in real time.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setHostOpen(true)}
          className="group flex w-full items-center gap-2.5 rounded-2xl bg-accent-3 px-2.5 py-2 text-left text-accent-ink transition hover:bg-accent-2/60"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-accent">
            <RocketIcon />
          </span>
          <span className="flex-1 text-[13px] font-medium text-ink">
            Host a new session and share the code
          </span>
          <ChevronRightIcon className="text-accent transition group-hover:translate-x-0.5" />
        </button>

        <form onSubmit={join} className="w-full">
          <Card className="p-3">
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={32}
              placeholder="Enter a quiz code"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent px-2 pt-1.5 pb-4 font-mono text-[15px] uppercase tracking-[0.25em] placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-mist outline-none"
            />
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={24}
                placeholder="Your name"
                className="h-8 flex-1 min-w-0 rounded-lg bg-panel border border-line px-3.5 text-[13px] outline-none placeholder:text-mist focus:bg-canvas focus:border-accent"
              />
              <button
                type="submit"
                disabled={!canJoin}
                aria-label="Join session"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
                  canJoin ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-panel text-mist'
                }`}
              >
                <ArrowUpIcon />
              </button>
            </div>
          </Card>
        </form>

        {offline && <p className="text-sm text-bad">Cannot reach the quiz server at {HTTP_URL}.</p>}
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>

      <Modal
        open={hostOpen}
        onOpenChange={setHostOpen}
        title="Host a new session"
        description="Pick a quiz. You will get a 6-letter code to share."
      >
        <div className="space-y-3">
          <QuizSelect quizzes={quizzes} value={definition} onChange={setDefinition} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            placeholder="Your name"
            className="h-9 w-full rounded-lg bg-panel border border-line px-3.5 text-[13px] outline-none placeholder:text-mist focus:bg-canvas focus:border-accent"
          />
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setHostOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy || !definition}>
              {busy ? 'Creating…' : 'Create session'}
            </Button>
          </div>
        </div>
      </Modal>

      <HowItWorks open={rulesOpen} onOpenChange={setRulesOpen} />
    </AppShell>
  )
}
