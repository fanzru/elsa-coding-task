'use client'

import type { AnswerResultMessage, PublicQuestion } from '@quiz/protocol'
import { Progress } from 'radix-ui'
import { Card } from './ui/Card'
import { useNow } from './useNow'

interface Props {
  question: PublicQuestion
  total: number
  phase: 'question' | 'reveal'
  serverOffset: number
  myChoice: number | null
  correctChoice: number | null
  lastResult: AnswerResultMessage | null
  stats: { answered: number; correctCount: number } | null
  onAnswer: (choice: number) => void
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

export function QuestionCard({
  question,
  total,
  phase,
  serverOffset,
  myChoice,
  correctChoice,
  lastResult,
  stats,
  onAnswer,
}: Props) {
  const now = useNow(50) + serverOffset
  const remainingMs = Math.max(0, question.endsAt - now)
  const fraction = Math.min(1, Math.max(0, remainingMs / question.timeLimitMs))
  const open = phase === 'question' && remainingMs > 0
  const answered = myChoice !== null
  const bar = phase === 'reveal' ? 'bg-line-2' : fraction > 0.25 ? 'bg-accent' : 'bg-bad'

  return (
    <Card className="p-4 fade-up" key={question.id}>
      <div className="flex items-center justify-between text-[11px] text-mist">
        <span>
          Question {question.index + 1} of {total}
        </span>
        <span className="font-mono tabular-nums">
          {phase === 'question' ? `${(remainingMs / 1000).toFixed(1)}s` : 'closed'}
        </span>
      </div>
      <Progress.Root
        value={fraction * 100}
        className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-panel-2"
      >
        <Progress.Indicator
          className={`h-full rounded-full ${bar} transition-transform duration-75 ease-linear`}
          style={{ transform: `translateX(-${100 - fraction * 100}%)` }}
        />
      </Progress.Root>

      <h2 className="mt-3.5 text-[18px] font-semibold leading-snug tracking-tight">
        {question.text}
      </h2>

      <div className="mt-3.5 grid gap-1.5 sm:grid-cols-2">
        {question.options.map((opt, i) => {
          const isMine = myChoice === i
          const isCorrect = correctChoice === i
          let cls = 'border-line bg-canvas hover:border-line-2 hover:bg-page'
          let badge = 'bg-panel text-ink-2'
          if (correctChoice !== null) {
            if (isCorrect) {
              cls = 'border-good/30 bg-good-2'
              badge = 'bg-good text-white'
            } else if (isMine) {
              cls = 'border-bad/30 bg-bad-2'
              badge = 'bg-bad text-white'
            } else cls = 'border-line opacity-50'
          } else if (isMine) {
            cls = 'border-accent bg-accent-3'
            badge = 'bg-accent text-white'
          } else if (answered) cls = 'border-line opacity-50'
          return (
            <button
              // options are positional by protocol (choice = index), so the index is the identity
              // biome-ignore lint/suspicious/noArrayIndexKey: index is the option's identity
              key={`${question.id}-${i}`}
              type="button"
              disabled={!open || answered}
              onClick={() => onAnswer(i)}
              className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-[13px] transition disabled:cursor-default ${cls}`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${badge}`}
              >
                {LETTERS[i]}
              </span>
              {opt}
            </button>
          )
        })}
      </div>

      <div className="mt-3 min-h-4 text-[12.5px]">
        {lastResult?.accepted && lastResult.correct && (
          <p className="text-good">
            Correct · +{lastResult.points} pts in {((lastResult.elapsedMs ?? 0) / 1000).toFixed(2)}s
            {lastResult.streak >= 2 ? ` · ${lastResult.streak} in a row` : ''}
          </p>
        )}
        {lastResult?.accepted && lastResult.correct === false && (
          <p className="text-bad">Not this one. No points this round.</p>
        )}
        {lastResult && !lastResult.accepted && (
          <p className="text-ink-2">Answer not counted ({lastResult.reason?.replace('_', ' ')}).</p>
        )}
        {!lastResult && answered && open && <p className="text-mist">Locked in.</p>}
        {!answered && open && <p className="text-mist">Faster answers earn more points.</p>}
        {phase === 'reveal' && stats && (
          <p className="mt-0.5 text-mist">
            {stats.correctCount} of {stats.answered} answered correctly.
          </p>
        )}
      </div>
    </Card>
  )
}
