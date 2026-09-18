import { parseServerMessage, type ServerMessage } from '@quiz/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Connection, QuizActor } from '../../src/actor/index.js'
import { createSession } from '../../src/domain/index.js'
import { FAST_RULES, freshMetrics, silentLogger, TEST_DEF } from '../helpers.js'

/** In-memory connection that records everything the actor sends to it. */
class FakeConn implements Connection {
  static n = 0
  readonly id = `fake${++FakeConn.n}`
  userId: string | null = null
  received: ServerMessage[] = []
  closed: { code: number; reason: string } | null = null
  /** Simulate a slow consumer: droppable messages are refused. */
  backpressured = false

  send(json: string, opts: { droppable: boolean }): boolean {
    if (this.backpressured && opts.droppable) return false
    const msg = parseServerMessage(json)
    if (!msg) throw new Error(`actor sent a message that violates the protocol: ${json}`)
    this.received.push(msg)
    return true
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type)
  }
  last(): ServerMessage | undefined {
    return this.received[this.received.length - 1]
  }
}

describe('QuizActor', () => {
  let actor: QuizActor
  let idle: QuizActor[]
  const INTERVAL = 100

  beforeEach(() => {
    // Fake timers also fake Date.now, so the actor's clock and its timers advance in lockstep —
    // a timer scheduled for t+1500 observes now === t+1500 when it fires, like production.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    idle = []
    actor = new QuizActor(createSession('T1', TEST_DEF, FAST_RULES, Date.now()), {
      clock: Date.now,
      logger: silentLogger,
      metrics: freshMetrics(),
      options: { leaderboardIntervalMs: INTERVAL, topN: 3, idleTtlMs: 5_000 },
      onIdle: (a) => idle.push(a),
    })
  })
  afterEach(() => {
    actor.dispose()
    vi.useRealTimers()
  })

  const advance = (ms: number) => vi.advanceTimersByTime(ms)
  const joinAll = (...names: string[]) =>
    names.map((name, i) => {
      const c = new FakeConn()
      actor.join(c, name, `u${i + 1}`)
      return c
    })
  const startQuestion = () => advance(FAST_RULES.lobbyMs)

  it('sends a welcome snapshot first, then streams broadcasts in seq order', () => {
    const [a] = joinAll('Ana')
    if (!a) throw new Error('unreachable')
    expect(a.received[0]?.type).toBe('welcome')
    expect(a.of('welcome')[0]).toMatchObject({ phase: 'lobby', you: { userId: 'u1', name: 'Ana' } })
    const seqs = a.received.flatMap((m) => ('seq' in m ? [m.seq] : []))
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1] ?? 0)
  })

  it('coalesces a burst of score changes: first change flushes at once, the rest ride one flush', () => {
    const conns = joinAll('A', 'B', 'C', 'D', 'E')
    startQuestion()
    advance(INTERVAL) // settle flushes caused by joining
    for (const c of conns) c.received.length = 0

    // 5 answers within 10 ms → 5 score changes
    for (const c of conns) {
      actor.answer(c, 'q1', 1)
      advance(2)
    }
    // Everyone got their own answer_result immediately (never coalesced)…
    for (const c of conns) expect(c.of('answer_result')).toHaveLength(1)
    // …the leading-edge flush carried only what had happened by then…
    expect(conns[0]?.of('leaderboard')).toHaveLength(1)
    expect(
      conns[0]?.of('leaderboard')[0]?.leaderboard.top.filter((e) => e.score > 0).length,
    ).toBeLessThan(5)

    advance(INTERVAL)
    // …and exactly one more flush contains every score.
    const flushes = conns[0]?.of('leaderboard') ?? []
    expect(flushes).toHaveLength(2)
    const lb = flushes[1]?.leaderboard
    expect(lb?.participants).toBe(5)
    expect(lb?.top).toHaveLength(3) // topN
    expect(lb?.top.every((e) => e.score > 0)).toBe(true)
    expect(lb?.top[0]?.userId).toBe('u1') // equal instant scores → whoever scored first ranks higher
    expect(conns[4]?.of('leaderboard')[1]?.leaderboard.you).toMatchObject({ userId: 'u5', rank: 5 })
  })

  it('bounds steady-state fan-out to one leaderboard broadcast per interval', () => {
    const conns = joinAll(...Array.from({ length: 20 }, (_, i) => `P${i}`))
    startQuestion()
    advance(INTERVAL)
    for (const c of conns) c.received.length = 0

    // 20 score changes spread over 400 ms (one every 20 ms)
    for (const c of conns) {
      actor.answer(c, 'q1', 1)
      advance(20)
    }
    advance(INTERVAL)
    const flushes = conns[0]?.of('leaderboard').length ?? 0
    // 400 ms / 100 ms interval → ≤ 5 flushes (+1 for the trailing one), never 20
    expect(flushes).toBeLessThanOrEqual(6)
    expect(flushes).toBeGreaterThanOrEqual(4)
    // and the final board is complete
    const last = conns[0]?.of('leaderboard').at(-1)?.leaderboard
    expect(last?.participants).toBe(20)
    expect(last?.top.every((e) => e.score > 0)).toBe(true)
  })

  it('does not broadcast when nothing on the board changed', () => {
    const [a] = joinAll('Ana')
    if (!a) throw new Error('unreachable')
    startQuestion()
    advance(INTERVAL) // drain any pending flush from the join
    a.received.length = 0
    actor.answer(a, 'q1', 0) // wrong, streak 0 → 0
    advance(INTERVAL * 3)
    expect(a.of('leaderboard')).toHaveLength(0)
    expect(a.of('answer_result')[0]).toMatchObject({ accepted: true, correct: false, points: 0 })
  })

  it('never drops questions/results to a backpressured socket, but skips leaderboards', () => {
    const [slow, fast] = joinAll('Slow', 'Fast')
    if (!slow || !fast) throw new Error('unreachable')
    slow.backpressured = true
    startQuestion()
    slow.received.length = 0
    fast.received.length = 0
    actor.answer(fast, 'q1', 1)
    actor.answer(slow, 'q1', 1)
    advance(INTERVAL)
    expect(fast.of('leaderboard')).toHaveLength(1)
    expect(slow.of('leaderboard')).toHaveLength(0)
    expect(slow.of('answer_result')).toHaveLength(1) // unicast is never droppable
    advance(FAST_RULES.questionTimeLimitMs + FAST_RULES.revealMs + 1_000)
    expect(slow.of('question_end').length).toBeGreaterThan(0)
    expect(slow.of('question').length).toBeGreaterThan(0) // next question arrived
  })

  it('gives a late joiner the current question and remaining time in the welcome', () => {
    joinAll('Ana')
    startQuestion()
    advance(300)
    const late = new FakeConn()
    actor.join(late, 'Late', 'u9')
    const w = late.of('welcome')[0]
    expect(w?.phase).toBe('question')
    expect(w?.question?.id).toBe('q1')
    expect(w?.question?.endsAt).toBe((w?.question?.startedAt ?? 0) + FAST_RULES.questionTimeLimitMs)
    expect(w?.correctChoice).toBeUndefined() // never leak the answer mid-question
    expect(w?.leaderboard.you).toMatchObject({ userId: 'u9', score: 0 })
  })

  it('reveals the correct answer in the welcome only during reveal', () => {
    joinAll('Ana')
    startQuestion()
    advance(FAST_RULES.questionTimeLimitMs + FAST_RULES.scoring.graceMs)
    const c = new FakeConn()
    actor.join(c, 'Rev', 'u9')
    expect(c.of('welcome')[0]).toMatchObject({ phase: 'reveal', correctChoice: 1 })
  })

  it('reconnecting with the same userId keeps the score and both tabs get results', () => {
    const [a] = joinAll('Ana')
    if (!a) throw new Error('unreachable')
    startQuestion()
    actor.answer(a, 'q1', 1)
    const score = a.of('answer_result')[0]?.score ?? 0
    expect(score).toBeGreaterThan(0)

    actor.detach(a)
    const a2 = new FakeConn()
    actor.join(a2, 'Ana', 'u1', 3)
    expect(a2.of('welcome')[0]?.leaderboard.you).toMatchObject({ score, rank: 1 })
    // second answer to the same question from the new tab is refused
    actor.answer(a2, 'q1', 1)
    expect(a2.of('answer_result')[0]).toMatchObject({
      accepted: false,
      reason: 'already_answered',
      score,
    })
  })

  it('runs the whole quiz on timers and ends with a per-user final board', () => {
    const conns = joinAll('A', 'B')
    startQuestion()
    for (let q = 0; q < TEST_DEF.questions.length; q++) {
      actor.answer(conns[0] as FakeConn, `q${q + 1}`, TEST_DEF.questions[q]?.correctChoice ?? 0)
      advance(FAST_RULES.questionTimeLimitMs + FAST_RULES.scoring.graceMs + FAST_RULES.revealMs + 5)
    }
    expect(actor.state.phase).toBe('finished')
    const end = conns[1]?.of('quiz_end')[0]
    expect(end?.leaderboard.top[0]).toMatchObject({ userId: 'u1', rank: 1, streak: 3 })
    expect(end?.leaderboard.you).toMatchObject({ userId: 'u2', rank: 2, score: 0 })
  })

  it('reports itself idle once every connection is gone for idleTtlMs', () => {
    const [a] = joinAll('Ana')
    if (!a) throw new Error('unreachable')
    actor.detach(a)
    advance(4_999)
    expect(idle).toHaveLength(0)
    advance(1)
    expect(idle).toEqual([actor])
  })

  it('exposes REST-friendly info and leaderboard', () => {
    joinAll('Ana', 'Bo')
    expect(actor.info()).toMatchObject({
      quizId: 'T1',
      phase: 'lobby',
      participants: 2,
      totalQuestions: 3,
    })
    expect(actor.leaderboard()).toMatchObject({ participants: 2 })
    expect(actor.leaderboard().you).toBeUndefined()
  })
})
