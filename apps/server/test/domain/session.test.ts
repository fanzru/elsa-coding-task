import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  createSession,
  DEFAULT_RULES,
  type DomainEvent,
  nextDeadline,
  type QuizDefinition,
  type SessionRules,
  type SessionState,
} from '../../src/domain/index.js'

const def: QuizDefinition = {
  id: 'vocab',
  title: 'Vocab',
  topic: 'Test',
  description: '',
  questions: [
    { id: 'q1', text: 'ubiquitous', options: ['rare', 'everywhere'], correctChoice: 1 },
    { id: 'q2', text: 'ephemeral', options: ['short-lived', 'eternal'], correctChoice: 0 },
  ],
}

const rules: SessionRules = {
  ...DEFAULT_RULES,
  lobbyMs: 1_000,
  questionTimeLimitMs: 10_000,
  revealMs: 2_000,
  endEarlyWhenAllAnswered: false,
}

function boot(now = 0, r: SessionRules = rules): SessionState {
  return createSession('Q', def, r, now)
}

const types = (events: DomainEvent[]) => events.map((e) => e.type)

describe('session state machine', () => {
  it('starts the lobby countdown on the first join, not on creation', () => {
    const s = boot(0)
    expect(nextDeadline(s)).toBeNull()
    const ev = applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 500 })
    expect(types(ev)).toEqual(['player_joined', 'lobby_opened'])
    expect(nextDeadline(s)).toBe(1_500)
    // second join does not restart the countdown
    applyCommand(s, { type: 'join', userId: 'u2', name: 'Bo', now: 900 })
    expect(nextDeadline(s)).toBe(1_500)
  })

  it('walks lobby → question → reveal → question → reveal → finished on ticks', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    expect(types(applyCommand(s, { type: 'tick', now: 999 }))).toEqual([]) // too early
    expect(types(applyCommand(s, { type: 'tick', now: 1_000 }))).toEqual(['question_started'])
    expect(s.phase).toBe('question')
    expect(s.currentIndex).toBe(0)
    expect(nextDeadline(s)).toBe(1_000 + 10_000 + rules.scoring.graceMs)

    expect(types(applyCommand(s, { type: 'tick', now: 11_500 }))).toEqual(['question_ended'])
    expect(s.phase).toBe('reveal')
    expect(types(applyCommand(s, { type: 'tick', now: 13_500 }))).toEqual(['question_started'])
    expect(s.currentIndex).toBe(1)
    expect(types(applyCommand(s, { type: 'tick', now: 24_000 }))).toEqual(['question_ended'])
    expect(types(applyCommand(s, { type: 'tick', now: 26_000 }))).toEqual(['quiz_finished'])
    expect(s.phase).toBe('finished')
    expect(nextDeadline(s)).toBeNull()
    expect(types(applyCommand(s, { type: 'tick', now: 99_999 }))).toEqual([])
  })

  it('scores a correct answer using server time, and only once per question', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })

    const first = applyCommand(s, {
      type: 'answer',
      userId: 'u1',
      questionId: 'q1',
      choice: 1,
      now: 3_500,
    })
    expect(first[0]).toMatchObject({
      type: 'answer_accepted',
      correct: true,
      elapsedMs: 2_500,
      points: 875,
      score: 875,
      streak: 1,
    })

    // Retry / double click: rejected, score untouched.
    const again = applyCommand(s, {
      type: 'answer',
      userId: 'u1',
      questionId: 'q1',
      choice: 0,
      now: 3_600,
    })
    expect(again[0]).toMatchObject({
      type: 'answer_rejected',
      reason: 'already_answered',
      score: 875,
    })
    expect(s.players.get('u1')?.score).toBe(875)
  })

  it('flags whether an answer changed the board, so unchanged boards are not re-broadcast', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'join', userId: 'u2', name: 'Bo', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })
    // wrong answer with no streak: nothing on the board moves
    expect(
      applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 0, now: 1_000 })[0],
    ).toMatchObject({
      boardChanged: false,
    })
    // correct answer: score and streak move
    expect(
      applyCommand(s, { type: 'answer', userId: 'u2', questionId: 'q1', choice: 1, now: 1_000 })[0],
    ).toMatchObject({
      boardChanged: true,
    })
    applyCommand(s, { type: 'tick', now: 11_500 })
    applyCommand(s, { type: 'tick', now: 13_500 })
    // wrong answer that breaks a streak: streak column changes → board changed
    expect(
      applyCommand(s, {
        type: 'answer',
        userId: 'u2',
        questionId: 'q2',
        choice: 1,
        now: 13_500,
      })[0],
    ).toMatchObject({
      correct: false,
      boardChanged: true,
    })
  })

  it('rejects answers outside the question window with precise reasons', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    expect(
      applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 10 })[0],
    ).toMatchObject({
      type: 'answer_rejected',
      reason: 'not_open',
    })
    applyCommand(s, { type: 'tick', now: 1_000 })
    expect(
      applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q2', choice: 1, now: 2_000 })[0],
    ).toMatchObject({
      reason: 'unknown_question',
    })
    // inside grace window: accepted at the floor
    expect(
      applyCommand(s, {
        type: 'answer',
        userId: 'u1',
        questionId: 'q1',
        choice: 1,
        now: 11_000 + 400,
      })[0],
    ).toMatchObject({ type: 'answer_accepted', points: 500 })

    const s2 = boot(0)
    applyCommand(s2, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s2, { type: 'tick', now: 1_000 })
    expect(
      applyCommand(s2, {
        type: 'answer',
        userId: 'u1',
        questionId: 'q1',
        choice: 1,
        now: 11_000 + 501,
      })[0],
    ).toMatchObject({ reason: 'too_late' })
  })

  it('tracks streaks across questions and resets them when a player does not answer', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })
    applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 1_000 })
    expect(s.players.get('u1')?.streak).toBe(1)
    applyCommand(s, { type: 'tick', now: 11_500 }) // q1 ends
    applyCommand(s, { type: 'tick', now: 13_500 }) // q2 opens
    const ev = applyCommand(s, {
      type: 'answer',
      userId: 'u1',
      questionId: 'q2',
      choice: 0,
      now: 13_500,
    })
    expect(ev[0]).toMatchObject({ points: 1100, streak: 2 }) // 1000 × 1.1 streak multiplier

    const s2 = boot(0)
    applyCommand(s2, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s2, { type: 'tick', now: 1_000 })
    applyCommand(s2, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 1_000 })
    applyCommand(s2, { type: 'tick', now: 11_500 })
    applyCommand(s2, { type: 'tick', now: 13_500 })
    applyCommand(s2, { type: 'tick', now: 24_000 }) // never answered q2
    expect(s2.players.get('u1')?.streak).toBe(0)
  })

  it('ends a question early once everyone has answered (when enabled)', () => {
    const s = boot(0, { ...rules, endEarlyWhenAllAnswered: true })
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'join', userId: 'u2', name: 'Bo', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })
    expect(
      types(
        applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 2_000 }),
      ),
    ).toEqual(['answer_accepted'])
    const ev = applyCommand(s, {
      type: 'answer',
      userId: 'u2',
      questionId: 'q1',
      choice: 0,
      now: 2_100,
    })
    expect(types(ev)).toEqual(['answer_accepted', 'question_ended'])
    expect(ev[1]).toMatchObject({ answered: 2, correctCount: 1, correctChoice: 1 })
    expect(s.phase).toBe('reveal')
  })

  it('lets a returning user keep their score and update their name', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })
    applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 1_000 })
    const ev = applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana 2', now: 5_000 })
    expect(ev[0]).toMatchObject({ type: 'player_joined', rejoined: true, participants: 1 })
    expect(s.players.get('u1')).toMatchObject({ name: 'Ana 2', score: 1000 })
  })

  it('`start` skips the lobby countdown, and is a no-op afterwards', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    expect(types(applyCommand(s, { type: 'start', now: 10 }))).toEqual(['question_started'])
    expect(types(applyCommand(s, { type: 'start', now: 20 }))).toEqual([])
  })

  it('tie-break: equal scores rank the player who got there first higher', () => {
    const s = boot(0)
    applyCommand(s, { type: 'join', userId: 'u1', name: 'Ana', now: 0 })
    applyCommand(s, { type: 'join', userId: 'u2', name: 'Bo', now: 0 })
    applyCommand(s, { type: 'tick', now: 1_000 })
    // both answer instantly and correctly → same points; u2 arrives first
    applyCommand(s, { type: 'answer', userId: 'u2', questionId: 'q1', choice: 1, now: 1_000 })
    applyCommand(s, { type: 'answer', userId: 'u1', questionId: 'q1', choice: 1, now: 1_000 })
    const u1 = s.players.get('u1')
    const u2 = s.players.get('u2')
    expect(u1?.score).toBe(u2?.score)
    expect((u2?.scoreSeq ?? 0) < (u1?.scoreSeq ?? 0)).toBe(true)
  })
})
