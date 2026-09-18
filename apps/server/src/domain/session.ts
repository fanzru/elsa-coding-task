/**
 * Quiz session state machine.
 *
 *   lobby ──(startsAt)──▶ question ──(endsAt+grace | all answered)──▶ reveal ──▶ question … ──▶ finished
 *
 * `applyCommand` is the ONLY way state changes. It mutates `state` in place (copying a map of
 * thousands of players per answer would be wasteful) but is otherwise deterministic: it never
 * reads the clock — every command carries `now` — and never performs I/O. It returns the list
 * of domain events that occurred, which the actor layer turns into wire messages and timers.
 *
 * Single-writer guarantee: the actor processes commands for one session strictly in order, so
 * there is no interleaving to reason about here.
 *
 * AI-assisted (Claude Code): see docs/AI_COLLABORATION.md #4 and #5 (`boardChanged`).
 */
import type { PublicQuestion } from '@quiz/protocol'
import { scoreAnswer } from './scoring.js'
import type {
  Player,
  QuestionDefinition,
  QuizDefinition,
  SessionRules,
  SessionState,
} from './types.js'

export type Command =
  | { type: 'join'; userId: string; name: string; now: number }
  | { type: 'answer'; userId: string; questionId: string; choice: number; now: number }
  | { type: 'start'; now: number }
  | { type: 'tick'; now: number }

export type RejectReason = 'already_answered' | 'too_late' | 'not_open' | 'unknown_question'

export type DomainEvent =
  | { type: 'player_joined'; userId: string; name: string; participants: number; rejoined: boolean }
  | { type: 'lobby_opened'; startsAt: number }
  | { type: 'question_started'; question: PublicQuestion }
  | {
      type: 'answer_accepted'
      userId: string
      questionId: string
      correct: boolean
      points: number
      elapsedMs: number
      score: number
      streak: number
      /** False when neither score nor streak moved (wrong answer, no streak) — no re-rank needed. */
      boardChanged: boolean
    }
  | {
      type: 'answer_rejected'
      userId: string
      questionId: string
      reason: RejectReason
      score: number
      streak: number
    }
  | {
      type: 'question_ended'
      questionId: string
      correctChoice: number
      answered: number
      correctCount: number
      nextAt: number
    }
  | { type: 'quiz_finished' }

export function createSession(
  quizId: string,
  definition: QuizDefinition,
  rules: SessionRules,
  now: number,
): SessionState {
  if (definition.questions.length === 0) throw new Error('quiz definition has no questions')
  return {
    quizId,
    definition,
    rules,
    phase: 'lobby',
    createdAt: now,
    currentIndex: -1,
    questionStartedAt: 0,
    questionEndsAt: 0,
    phaseUntil: null,
    players: new Map(),
    nextScoreSeq: 1,
  }
}

/** The server time at which a `tick` is needed to advance the state, or null if none is pending. */
export function nextDeadline(state: SessionState): number | null {
  switch (state.phase) {
    case 'lobby':
    case 'reveal':
      return state.phaseUntil
    case 'question':
      return state.questionEndsAt + state.rules.scoring.graceMs
    case 'finished':
      return null
  }
}

export function currentQuestion(state: SessionState): QuestionDefinition | undefined {
  return state.definition.questions[state.currentIndex]
}

export function timeLimitFor(state: SessionState, q: QuestionDefinition): number {
  return q.timeLimitMs ?? state.rules.questionTimeLimitMs
}

export function toPublicQuestion(state: SessionState, q: QuestionDefinition): PublicQuestion {
  return {
    id: q.id,
    index: state.currentIndex,
    text: q.text,
    options: q.options,
    timeLimitMs: timeLimitFor(state, q),
    startedAt: state.questionStartedAt,
    endsAt: state.questionEndsAt,
  }
}

export function applyCommand(state: SessionState, cmd: Command): DomainEvent[] {
  switch (cmd.type) {
    case 'join':
      return join(state, cmd)
    case 'answer':
      return answer(state, cmd)
    case 'start':
      return state.phase === 'lobby' ? openQuestion(state, 0, cmd.now) : []
    case 'tick':
      return tick(state, cmd.now)
  }
}

// ---------------------------------------------------------------------------

function join(state: SessionState, cmd: Extract<Command, { type: 'join' }>): DomainEvent[] {
  const events: DomainEvent[] = []
  const existing = state.players.get(cmd.userId)
  if (existing) {
    // Reconnect / refresh: keep score, allow a display-name update.
    existing.name = cmd.name
    events.push({
      type: 'player_joined',
      userId: existing.userId,
      name: existing.name,
      participants: state.players.size,
      rejoined: true,
    })
    return events
  }

  const player: Player = {
    userId: cmd.userId,
    name: cmd.name,
    score: 0,
    streak: 0,
    scoreSeq: state.nextScoreSeq++,
    joinedAt: cmd.now,
    answers: new Map(),
  }
  state.players.set(player.userId, player)
  events.push({
    type: 'player_joined',
    userId: player.userId,
    name: player.name,
    participants: state.players.size,
    rejoined: false,
  })

  // The lobby countdown starts with the first player, not at session creation, so an
  // empty session created via REST does not run through its questions with nobody in it.
  if (state.phase === 'lobby' && state.phaseUntil === null) {
    state.phaseUntil = cmd.now + state.rules.lobbyMs
    events.push({ type: 'lobby_opened', startsAt: state.phaseUntil })
  }
  return events
}

function answer(state: SessionState, cmd: Extract<Command, { type: 'answer' }>): DomainEvent[] {
  const player = state.players.get(cmd.userId)
  if (!player) return [] // transport guarantees a join happened first; be defensive anyway

  const reject = (reason: RejectReason): DomainEvent[] => [
    {
      type: 'answer_rejected',
      userId: player.userId,
      questionId: cmd.questionId,
      reason,
      score: player.score,
      streak: player.streak,
    },
  ]

  if (state.phase !== 'question') return reject('not_open')
  const question = currentQuestion(state)
  if (!question || question.id !== cmd.questionId) return reject('unknown_question')
  // Idempotency: the first answer per (user, question) is the only one that counts. A retry
  // after a flaky network, or a double-click, must never double-score or overwrite.
  if (player.answers.has(question.id)) return reject('already_answered')

  const elapsedMs = Math.max(0, cmd.now - state.questionStartedAt)
  if (cmd.now > state.questionEndsAt + state.rules.scoring.graceMs) return reject('too_late')

  const timeLimitMs = timeLimitFor(state, question)
  const result = scoreAnswer(
    question,
    cmd.choice,
    elapsedMs,
    timeLimitMs,
    player.streak,
    state.rules.scoring,
  )

  player.answers.set(question.id, {
    choice: cmd.choice,
    correct: result.correct,
    points: result.points,
    elapsedMs,
  })
  const boardChanged = result.points > 0 || player.streak !== result.streakAfter
  player.streak = result.streakAfter
  if (result.points > 0) {
    player.score += result.points
    player.scoreSeq = state.nextScoreSeq++
  }

  const events: DomainEvent[] = [
    {
      type: 'answer_accepted',
      userId: player.userId,
      questionId: question.id,
      correct: result.correct,
      points: result.points,
      elapsedMs,
      score: player.score,
      streak: player.streak,
      boardChanged,
    },
  ]

  if (state.rules.endEarlyWhenAllAnswered && everyoneAnswered(state, question.id)) {
    events.push(...endQuestion(state, cmd.now))
  }
  return events
}

function tick(state: SessionState, now: number): DomainEvent[] {
  const deadline = nextDeadline(state)
  if (deadline === null || now < deadline) return []

  switch (state.phase) {
    case 'lobby':
      return openQuestion(state, 0, now)
    case 'question':
      return endQuestion(state, now)
    case 'reveal': {
      const next = state.currentIndex + 1
      if (next >= state.definition.questions.length) {
        state.phase = 'finished'
        state.phaseUntil = null
        return [{ type: 'quiz_finished' }]
      }
      return openQuestion(state, next, now)
    }
    case 'finished':
      return []
  }
}

function openQuestion(state: SessionState, index: number, now: number): DomainEvent[] {
  const q = state.definition.questions[index]
  if (!q) throw new Error(`question index ${index} out of range`)
  state.phase = 'question'
  state.currentIndex = index
  state.questionStartedAt = now
  state.questionEndsAt = now + timeLimitFor(state, q)
  state.phaseUntil = null
  return [{ type: 'question_started', question: toPublicQuestion(state, q) }]
}

function endQuestion(state: SessionState, now: number): DomainEvent[] {
  const q = currentQuestion(state)
  if (!q) throw new Error('endQuestion called with no current question')
  let answered = 0
  let correctCount = 0
  for (const p of state.players.values()) {
    const a = p.answers.get(q.id)
    if (!a) {
      // Not answering breaks the streak just like a wrong answer would.
      p.streak = 0
      continue
    }
    answered++
    if (a.correct) correctCount++
  }
  state.phase = 'reveal'
  state.phaseUntil = now + state.rules.revealMs
  return [
    {
      type: 'question_ended',
      questionId: q.id,
      correctChoice: q.correctChoice,
      answered,
      correctCount,
      nextAt: state.phaseUntil,
    },
  ]
}

function everyoneAnswered(state: SessionState, questionId: string): boolean {
  for (const p of state.players.values()) {
    if (!p.answers.has(questionId)) return false
  }
  return state.players.size > 0
}
