'use client'

import type { RankedPlayer } from '@quiz/protocol'
import { CheckIcon, CopyIcon, ExitIcon, InfoCircledIcon, PersonIcon } from '@radix-ui/react-icons'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { loadSession } from '@/lib/auth'
import { HTTP_URL } from '@/lib/config'
import { useQuizSocket } from '@/lib/useQuizSocket'
import { Leaderboard } from './Leaderboard'
import { QuestionCard } from './QuestionCard'
import { AppShell } from './ui/AppShell'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { ConnectionBadge } from './ui/ConnectionBadge'
import { HowItWorks } from './ui/HowItWorks'
import { Mascot } from './ui/Mascot'
import { Modal } from './ui/Modal'
import { fetchRanking } from './ui/RankedModal'
import { useNow } from './useNow'

export function QuizRoom({ quizId, initialName }: { quizId: string; initialName: string }) {
  const [name, setName] = useState(initialName)
  // A shared link has no ?name=; a logged-in player skips the prompt.
  useEffect(() => {
    if (!initialName) {
      const s = loadSession()
      if (s) setName(s.user.name)
    }
  }, [initialName])
  // Bumping the key remounts the room with a fresh socket (used by "Play again").
  const [run, setRun] = useState(0)
  if (!name) return <NamePrompt quizId={quizId} onSubmit={setName} />
  return <Room key={run} quizId={quizId} name={name} onRestart={() => setRun((r) => r + 1)} />
}

function Room({
  quizId,
  name,
  onRestart,
}: {
  quizId: string
  name: string
  onRestart: () => void
}) {
  const router = useRouter()
  const { state, answer } = useQuizSocket(quizId, name)
  const [restarting, setRestarting] = useState(false)

  const playAgain = async () => {
    setRestarting(true)
    try {
      // Fresh run under the same code; the server closes old sockets, we reconnect via remount.
      await fetch(`${HTTP_URL}/api/sessions/${encodeURIComponent(quizId)}/restart`, {
        method: 'POST',
      })
    } catch {
      /* the remount will re-join whatever state the session is in */
    }
    onRestart()
  }
  const now = useNow(200) + state.serverOffset
  const [rulesOpen, setRulesOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [overall, setOverall] = useState<RankedPlayer | null>(null)
  useEffect(() => {
    if (state.phase !== 'finished' || !loadSession()) return
    // The server records results off the hot path right after `quiz_end`; give it a beat.
    const t = setTimeout(
      () =>
        fetchRanking(1)
          .then((r) => setOverall(r.me))
          .catch(() => undefined),
      600,
    )
    return () => clearTimeout(t)
  }, [state.phase])

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/quiz/${encodeURIComponent(quizId)}`,
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const total = state.quiz?.totalQuestions ?? 0
  const secondsTo = (t: number | null) => (t ? Math.max(0, Math.ceil((t - now) / 1000)) : 0)

  return (
    <AppShell
      sidebar={{
        items: [
          {
            icon: copied ? <CheckIcon /> : <CopyIcon />,
            label: copied ? 'Link copied' : 'Copy invite link',
            onSelect: copyInvite,
          },
          { icon: <ExitIcon />, label: 'Leave session', href: '/' },
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
        children: (
          <div className="rounded-xl bg-page border border-line px-2.5 py-2 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-xs text-mist">Session</span>
              <span className="font-mono text-xs tracking-[0.2em]">{quizId}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-xs text-mist">Players</span>
              <span className="inline-flex items-center gap-1 text-xs">
                <PersonIcon className="text-mist" /> {state.leaderboard.participants}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-xs text-mist">Progress</span>
              <span className="text-xs">
                {state.question
                  ? `${state.question.index + 1} / ${total}`
                  : state.phase === 'finished'
                    ? 'done'
                    : '—'}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-xs text-mist">Quiz</span>
              <span className="truncate text-xs">{state.quiz?.title ?? '—'}</span>
            </div>
          </div>
        ),
      }}
      topCenter={<ConnectionBadge status={state.status} rtt={state.rtt} />}
      topRight={
        <>
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[13px] text-ink-2 px-2">
            <PersonIcon className="text-mist" /> {state.you?.name ?? name}
          </span>
          <Button variant="secondary" onClick={() => router.push('/')}>
            Leave
          </Button>
        </>
      }
    >
      <div className="mx-auto my-auto w-full grid max-w-[920px] gap-2 py-2 xl:grid-cols-[1fr_264px]">
        <div className="min-w-0">
          {state.error && (
            <div className="mb-2 rounded-xl border border-bad/20 bg-bad-2 px-3 py-2 text-[13px] text-bad">
              {state.error}
            </div>
          )}

          {state.phase === 'lobby' && (
            <div className="flex flex-col items-center py-8 text-center fade-up">
              <Mascot size={36} />
              <p className="mt-3 text-[11px] text-mist">
                Waiting for players · {state.leaderboard.participants} joined
              </p>
              <h1 className="mt-1.5 text-[22px] font-semibold tracking-tight">
                {state.startsAt ? `Starting in ${secondsTo(state.startsAt)}s` : 'Waiting to start'}
              </h1>
              <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-ink-2">
                Share the code <span className="font-mono text-ink tracking-[0.2em]">{quizId}</span>{' '}
                so others can join before the first question.
              </p>
              <button
                type="button"
                onClick={copyInvite}
                className="mt-5 flex w-full max-w-[400px] items-center gap-2.5 rounded-2xl bg-accent-3 px-2.5 py-2 text-left text-accent-ink transition hover:bg-accent-2/60"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-accent">
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </span>
                <span className="flex-1 text-[13px] font-medium text-ink">
                  {copied ? 'Invite link copied' : 'Copy the invite link'}
                </span>
              </button>
            </div>
          )}

          {(state.phase === 'question' || state.phase === 'reveal') && state.question && (
            <>
              <QuestionCard
                question={state.question}
                total={total}
                phase={state.phase}
                serverOffset={state.serverOffset}
                myChoice={state.myChoice}
                correctChoice={state.correctChoice}
                lastResult={state.lastResult}
                stats={state.questionStats}
                onAnswer={answer}
              />
              {state.phase === 'reveal' && state.nextAt && (
                <p className="mt-2 text-center text-[11px] text-mist">
                  {state.question.index + 1 < total
                    ? `Next question in ${secondsTo(state.nextAt)}s`
                    : `Results in ${secondsTo(state.nextAt)}s`}
                </p>
              )}
            </>
          )}

          {state.phase === 'finished' && (
            <div className="flex flex-col items-center py-8 text-center fade-up">
              <Mascot size={36} />
              <p className="mt-3 text-[11px] text-mist">
                Session finished · {state.leaderboard.participants} played
              </p>
              <h1 className="mt-1.5 text-[22px] font-semibold tracking-tight">
                {state.leaderboard.you
                  ? `You finished #${state.leaderboard.you.rank}`
                  : 'That is a wrap'}
              </h1>
              <p className="mt-1.5 max-w-[340px] text-[13px] leading-relaxed text-ink-2">
                {state.leaderboard.you
                  ? `${state.leaderboard.you.score.toLocaleString()} points.`
                  : ''}{' '}
                {state.leaderboard.top[0] && (
                  <>
                    Winner: <span className="text-ink">{state.leaderboard.top[0].name}</span> with{' '}
                    {state.leaderboard.top[0].score.toLocaleString()}.
                  </>
                )}
              </p>
              {overall && (
                <p className="mt-1.5 text-[12px] text-accent">
                  Ranked #{overall.rank} overall · {overall.totalScore.toLocaleString()} pts ·{' '}
                  {overall.wins} win{overall.wins === 1 ? '' : 's'}
                </p>
              )}
              <div className="mt-5 flex items-center gap-2">
                <Button onClick={playAgain} disabled={restarting}>
                  {restarting ? 'Starting…' : 'Play again'}
                </Button>
                <Button variant="secondary" onClick={copyInvite}>
                  {copied ? 'Link copied' : 'Invite friends'}
                </Button>
                <Button variant="ghost" onClick={() => router.push('/')}>
                  Home
                </Button>
              </div>
            </div>
          )}

          {!state.phase && !state.error && (
            <Card className="p-4">
              <p className="text-[13px] text-mist">Joining {quizId}…</p>
            </Card>
          )}
        </div>

        <div className="min-w-0">
          <Leaderboard data={state.leaderboard} youId={state.you?.userId ?? null} />
        </div>
      </div>

      <HowItWorks open={rulesOpen} onOpenChange={setRulesOpen} />
    </AppShell>
  )
}

function NamePrompt({ quizId, onSubmit }: { quizId: string; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Modal
      open
      onOpenChange={() => undefined}
      title={`Join ${quizId}`}
      description="What should we call you on the leaderboard?"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
        className="space-y-3"
      >
        <input
          // biome-ignore lint/a11y/noAutofocus: single-field dialog, focusing it is the whole point
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={24}
          placeholder="Your name"
          className="h-9 w-full rounded-lg bg-panel border border-line px-3.5 text-[13px] outline-none placeholder:text-mist focus:bg-canvas focus:border-accent"
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={!value.trim()}>
            Join
          </Button>
        </div>
      </form>
    </Modal>
  )
}
