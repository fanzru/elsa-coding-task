/**
 * QuizActor — one instance per live quiz session; the single writer for that session's state.
 *
 * Responsibilities
 *  - Owns the `SessionState` and feeds it commands **strictly in order** (Node's single thread
 *    plus synchronous handling is our "mailbox"; nothing awaits between reading state and
 *    writing it). This is where "scores must be accurate and consistent" is guaranteed.
 *  - Translates domain events into wire messages: unicast to the answering user, broadcast
 *    to everyone.
 *  - Schedules phase-transition timers from `nextDeadline()`.
 *  - **Coalesces leaderboard broadcasts**: scores update instantly, but the board is pushed at
 *    most once per `leaderboardIntervalMs`. 5 000 answers in one second become ≤ 10 fan-outs
 *    instead of 5 000 — the single most important performance decision in this server.
 *
 * AI-assisted (Claude Code): drafted by the AI; the stale-cache bug in `dispatch()` and the
 * O(N²) join broadcast were found and fixed through tests and load runs.
 * See docs/AI_COLLABORATION.md #4 and #5.
 */
import type {
  Leaderboard,
  LeaderboardEntry,
  SequencedServerMessage,
  SessionInfo,
} from '@quiz/protocol'
import {
  applyCommand,
  buildBoard,
  type Command,
  currentQuestion,
  type DomainEvent,
  nextDeadline,
  type RankedBoard,
  type SessionState,
  toPublicQuestion,
} from '../domain/index.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import type { Connection } from './connection.js'

export interface ActorOptions {
  leaderboardIntervalMs: number
  topN: number
  idleTtlMs: number
}

export interface ActorDeps {
  clock: () => number
  logger: Logger
  metrics: Metrics
  options: ActorOptions
  /** Called when the session has had no connections for `idleTtlMs`. */
  onIdle: (actor: QuizActor) => void
  /** Called once with the final standings — the hook for archiving results off the hot path. */
  onQuizFinished?: ((state: SessionState, standings: LeaderboardEntry[]) => void) | undefined
}

export class QuizActor {
  readonly quizId: string
  readonly state: SessionState
  private readonly deps: ActorDeps
  private readonly log: Logger

  private readonly conns = new Map<string, Connection>()
  private readonly connsByUser = new Map<string, Set<Connection>>()

  private seq = 0
  private tickTimer: NodeJS.Timeout | null = null
  private scheduledDeadline: number | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private lastFlushAt = Number.NEGATIVE_INFINITY
  private boardDirty = true
  private boardCache: RankedBoard | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(state: SessionState, deps: ActorDeps) {
    this.quizId = state.quizId
    this.state = state
    this.deps = deps
    this.log = deps.logger.child({ quizId: state.quizId })
    this.armIdleTimer()
  }

  // ---------------------------------------------------------------- commands

  /** Attach a connection as `userId` (new or returning) and send the snapshot. */
  join(conn: Connection, name: string, userId: string, lastSeq?: number): void {
    this.assertLive()
    if (conn.userId && conn.userId !== userId) this.detach(conn)
    conn.userId = userId
    this.conns.set(conn.id, conn)
    let set = this.connsByUser.get(userId)
    if (!set) {
      set = new Set()
      this.connsByUser.set(userId, set)
    }
    set.add(conn)
    this.disarmIdleTimer()

    const now = this.deps.clock()
    const events = this.dispatch({ type: 'join', userId, name, now })

    if (lastSeq !== undefined) {
      this.log.info(
        { userId, lastSeq, seq: this.seq, behind: this.seq - lastSeq },
        'client reconnected',
      )
    }

    // Snapshot-then-stream: the welcome is built *after* the join command is applied and sent
    // before any later broadcast, so the client can never observe a gap.
    conn.send(JSON.stringify(this.buildWelcome(userId, name)), { droppable: false })
    this.deps.metrics.messagesSent.inc({ type: 'welcome' })
    this.emit(events)
  }

  answer(conn: Connection, questionId: string, choice: number): void {
    this.assertLive()
    if (!conn.userId) return
    const started = performance.now()
    const events = this.dispatch({
      type: 'answer',
      userId: conn.userId,
      questionId,
      choice,
      now: this.deps.clock(),
    })
    this.emit(events)
    this.deps.metrics.answerProcessing.observe((performance.now() - started) / 1000)
  }

  /** Skip the lobby countdown (demo / admin convenience). */
  start(): void {
    this.assertLive()
    this.emit(this.dispatch({ type: 'start', now: this.deps.clock() }))
  }

  detach(conn: Connection): void {
    if (!this.conns.delete(conn.id)) return
    if (conn.userId) {
      const set = this.connsByUser.get(conn.userId)
      set?.delete(conn)
      if (set && set.size === 0) this.connsByUser.delete(conn.userId)
    }
    if (this.conns.size === 0) this.armIdleTimer()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.tickTimer) clearTimeout(this.tickTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const conn of this.conns.values()) conn.close(1001, 'session closed')
    this.conns.clear()
    this.connsByUser.clear()
    this.log.info('session disposed')
  }

  // ---------------------------------------------------------------- queries

  get connectionCount(): number {
    return this.conns.size
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  info(): SessionInfo {
    return {
      quizId: this.quizId,
      title: this.state.definition.title,
      totalQuestions: this.state.definition.questions.length,
      phase: this.state.phase,
      participants: this.state.players.size,
    }
  }

  /** Public leaderboard (no `you`), e.g. for the REST fallback. */
  leaderboard(): Leaderboard {
    const board = this.rankedBoard()
    return {
      top: board.entries.slice(0, this.deps.options.topN),
      participants: board.entries.length,
    }
  }

  // ---------------------------------------------------------------- internals

  private assertLive(): void {
    if (this.disposed) throw new Error(`session ${this.quizId} is disposed`)
  }

  /** The one place state changes. Synchronous ⇒ commands never interleave. */
  private dispatch(cmd: Command): DomainEvent[] {
    const events = applyCommand(this.state, cmd)
    // Invalidate the ranking cache here, not in emit(): the welcome snapshot is built between
    // the two and must already include the player who just joined.
    if (events.some(changesBoard)) this.boardDirty = true
    this.reschedule()
    return events
  }

  private emit(events: DomainEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'player_joined':
          // No broadcast here (it would be O(N²) during a join storm); the participant count
          // reaches everyone through the next coalesced leaderboard flush.
          if (!ev.rejoined) {
            this.deps.metrics.participants.inc()
            this.scheduleFlush()
          }
          break
        case 'lobby_opened':
          this.broadcast(
            { type: 'lobby', seq: 0, startsAt: ev.startsAt, participants: this.state.players.size },
            { droppable: false },
          )
          break
        case 'question_started':
          this.broadcast(
            { type: 'question', seq: 0, question: ev.question, serverTime: this.deps.clock() },
            { droppable: false },
          )
          break
        case 'answer_accepted':
          this.deps.metrics.answersTotal.inc({ result: ev.correct ? 'correct' : 'wrong' })
          if (ev.boardChanged) this.scheduleFlush()
          this.unicast(ev.userId, {
            type: 'answer_result',
            seq: this.seq,
            questionId: ev.questionId,
            accepted: true,
            correct: ev.correct,
            points: ev.points,
            elapsedMs: ev.elapsedMs,
            score: ev.score,
            streak: ev.streak,
          })
          break
        case 'answer_rejected':
          this.deps.metrics.answersTotal.inc({ result: `rejected_${ev.reason}` })
          this.unicast(ev.userId, {
            type: 'answer_result',
            seq: this.seq,
            questionId: ev.questionId,
            accepted: false,
            reason: ev.reason,
            score: ev.score,
            streak: ev.streak,
          })
          break
        case 'question_ended':
          this.broadcast(
            {
              type: 'question_end',
              seq: 0,
              questionId: ev.questionId,
              correctChoice: ev.correctChoice,
              answered: ev.answered,
              correctCount: ev.correctCount,
              nextAt: ev.nextAt,
            },
            { droppable: false },
          )
          // The reveal screen must show the final standings for this question right away.
          this.flushLeaderboard()
          break
        case 'quiz_finished':
          this.broadcastWithYou('quiz_end', { droppable: false })
          this.log.info({ participants: this.state.players.size }, 'quiz finished')
          this.deps.onQuizFinished?.(this.state, this.rankedBoard().entries)
          break
      }
    }
  }

  private buildWelcome(userId: string, name: string) {
    const s = this.state
    const q = currentQuestion(s)
    const board = this.rankedBoard()
    const you = board.byUser.get(userId)
    return {
      type: 'welcome' as const,
      seq: this.seq,
      you: { userId, name },
      quiz: {
        id: s.quizId,
        title: s.definition.title,
        totalQuestions: s.definition.questions.length,
      },
      phase: s.phase,
      ...(q && (s.phase === 'question' || s.phase === 'reveal')
        ? { question: toPublicQuestion(s, q) }
        : {}),
      ...(q && s.phase === 'reveal' ? { correctChoice: q.correctChoice } : {}),
      ...(s.phase === 'lobby' && s.phaseUntil !== null ? { startsAt: s.phaseUntil } : {}),
      leaderboard: {
        top: board.entries.slice(0, this.deps.options.topN),
        participants: board.entries.length,
        ...(you ? { you } : {}),
      },
      serverTime: this.deps.clock(),
    }
  }

  // ---- timers -------------------------------------------------------------

  private reschedule(): void {
    const deadline = nextDeadline(this.state)
    if (deadline === this.scheduledDeadline) return
    if (this.tickTimer) clearTimeout(this.tickTimer)
    this.tickTimer = null
    this.scheduledDeadline = deadline
    if (deadline === null) return
    // Timers may fire marginally early; the reducer ignores early ticks and we re-arm.
    const delay = Math.max(1, Math.ceil(deadline - this.deps.clock()))
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null
      this.scheduledDeadline = null
      if (this.disposed) return
      this.emit(this.dispatch({ type: 'tick', now: this.deps.clock() }))
    }, delay)
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.disposed) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.conns.size === 0) this.deps.onIdle(this)
    }, this.deps.options.idleTtlMs)
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  // ---- leaderboard fan-out ------------------------------------------------

  private rankedBoard(): RankedBoard {
    if (this.boardDirty || !this.boardCache) {
      this.boardCache = buildBoard(this.state.players.values())
      this.boardDirty = false
    }
    return this.boardCache
  }

  /**
   * Request a leaderboard broadcast. Leading-edge coalescing: if the last flush was more than
   * `leaderboardIntervalMs` ago it happens on the next tick (lowest latency for the first change
   * in a burst); otherwise it is deferred so that steady-state fan-out is ≤ 1 per interval.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    const now = this.deps.clock()
    const delay = Math.max(0, this.lastFlushAt + this.deps.options.leaderboardIntervalMs - now)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (!this.disposed) this.flushLeaderboard()
    }, delay)
  }

  private flushLeaderboard(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.lastFlushAt = this.deps.clock()
    const started = performance.now()
    this.broadcastWithYou('leaderboard', { droppable: true })
    this.deps.metrics.leaderboardFlush.observe((performance.now() - started) / 1000)
  }

  /**
   * Broadcast a leaderboard-carrying message where each recipient also gets their own entry.
   * The common part is serialised once; the per-connection part is spliced in as a string,
   * which avoids N full `JSON.stringify` calls per flush (measurable at thousands of sockets).
   */
  private broadcastWithYou(type: 'leaderboard' | 'quiz_end', opts: { droppable: boolean }): void {
    if (this.conns.size === 0) return
    const board = this.rankedBoard()
    const seq = ++this.seq
    const base = JSON.stringify({
      type,
      seq,
      leaderboard: {
        top: board.entries.slice(0, this.deps.options.topN),
        participants: board.entries.length,
      },
    })
    let sent = 0
    let dropped = 0
    for (const conn of this.conns.values()) {
      const you = conn.userId ? board.byUser.get(conn.userId) : undefined
      const json = you ? spliceYou(base, you) : base
      if (conn.send(json, opts)) sent++
      else dropped++
    }
    this.deps.metrics.messagesSent.inc({ type }, sent)
    if (dropped) this.deps.metrics.messagesDropped.inc({ reason: 'send_failed' }, dropped)
  }

  private broadcast(msg: SequencedServerMessage, opts: { droppable: boolean }): void {
    if (this.conns.size === 0) {
      this.seq++
      return
    }
    msg.seq = ++this.seq
    const json = JSON.stringify(msg)
    let sent = 0
    let dropped = 0
    for (const conn of this.conns.values()) {
      if (conn.send(json, opts)) sent++
      else dropped++
    }
    this.deps.metrics.messagesSent.inc({ type: msg.type }, sent)
    if (dropped) this.deps.metrics.messagesDropped.inc({ reason: 'send_failed' }, dropped)
  }

  private unicast(userId: string, msg: SequencedServerMessage): void {
    const set = this.connsByUser.get(userId)
    if (!set) return
    const json = JSON.stringify(msg)
    for (const conn of set) {
      if (conn.send(json, { droppable: false }))
        this.deps.metrics.messagesSent.inc({ type: msg.type })
    }
  }
}

/** Events after which standings (score, streak, membership) may differ. */
function changesBoard(ev: DomainEvent): boolean {
  switch (ev.type) {
    case 'player_joined':
      return !ev.rejoined
    case 'answer_accepted':
      return ev.boardChanged
    case 'question_ended': // streaks of non-answerers are reset
    case 'quiz_finished':
      return true
    default:
      return false
  }
}

/**
 * Insert `"you": {...}` into an already-serialised leaderboard message. `base` always ends with
 * `}}` (closing `leaderboard`, then the message), so we re-open before the last two braces.
 * Verified against the protocol schema in test/actor/splice.test.ts.
 */
export function spliceYou(base: string, you: LeaderboardEntry): string {
  return `${base.slice(0, -2)},"you":${JSON.stringify(you)}}}`
}
