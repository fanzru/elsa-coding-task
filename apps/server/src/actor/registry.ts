/**
 * SessionRegistry — maps quiz ids to live actors on this instance and owns their lifecycle.
 *
 * In a multi-instance deployment this is the seam where a session lookup consults a shared
 * directory (Redis) to find the owning instance — see docs/DESIGN.md → "Scaling out".
 */
import type { LeaderboardEntry, SessionInfo, SessionOverrides } from '@quiz/protocol'
import {
  createSession,
  type QuizDefinition,
  type SessionRules,
  type SessionState,
} from '../domain/index.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import { type ActorOptions, QuizActor } from './quiz-actor.js'

export interface RegistryDeps {
  clock: () => number
  logger: Logger
  metrics: Metrics
  definitions: QuizDefinition[]
  defaultRules: SessionRules
  actorOptions: ActorOptions
  autoCreate: boolean
  /** Lifecycle hooks used by the cluster layer to claim/release ownership. */
  onCreated?: ((actor: QuizActor) => void) | undefined
  onDisposed?: ((actor: QuizActor) => void) | undefined
  onQuizFinished?: ((state: SessionState, standings: LeaderboardEntry[]) => void) | undefined
}

export interface CreateOptions {
  quizId?: string | undefined
  quizDefinitionId?: string | undefined
  overrides?: SessionOverrides | undefined
}

export class SessionNotFoundError extends Error {
  constructor(quizId: string) {
    super(`quiz session "${quizId}" not found`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionExistsError extends Error {
  constructor(quizId: string) {
    super(`quiz session "${quizId}" already exists`)
    this.name = 'SessionExistsError'
  }
}

export class DefinitionNotFoundError extends Error {
  constructor(id: string) {
    super(`quiz definition "${id}" not found`)
    this.name = 'DefinitionNotFoundError'
  }
}

export class SessionRegistry {
  private readonly actors = new Map<string, QuizActor>()
  private readonly deps: RegistryDeps

  constructor(deps: RegistryDeps) {
    if (deps.definitions.length === 0) throw new Error('at least one quiz definition is required')
    this.deps = deps
  }

  get definitions(): QuizDefinition[] {
    return this.deps.definitions
  }

  create(opts: CreateOptions = {}): QuizActor {
    const quizId = opts.quizId ?? this.generateId()
    if (this.actors.has(quizId)) throw new SessionExistsError(quizId)
    const definition = this.resolveDefinition(opts.quizDefinitionId)
    const rules = mergeRules(this.deps.defaultRules, opts.overrides)
    const state = createSession(quizId, definition, rules, this.deps.clock())
    const actor = new QuizActor(state, {
      clock: this.deps.clock,
      logger: this.deps.logger,
      metrics: this.deps.metrics,
      options: this.deps.actorOptions,
      onIdle: (a) => {
        this.deps.logger.info({ quizId: a.quizId, phase: a.state.phase }, 'session idle, disposing')
        this.dispose(a.quizId)
      },
      onQuizFinished: this.deps.onQuizFinished,
    })
    this.actors.set(quizId, actor)
    this.deps.metrics.sessionsActive.set(this.actors.size)
    this.deps.logger.info({ quizId, definition: definition.id, rules }, 'session created')
    this.deps.onCreated?.(actor)
    return actor
  }

  get(quizId: string): QuizActor | undefined {
    return this.actors.get(quizId)
  }

  /**
   * Resolve for a joining client; auto-creates when allowed. A finished session that nobody is
   * looking at any more starts a fresh run under the same code, so a shared code like "DEMO"
   * keeps working instead of dropping late arrivals onto a stale results screen.
   */
  resolveForJoin(quizId: string): QuizActor {
    const existing = this.actors.get(quizId)
    if (existing) return this.freshIfStale(existing)
    if (!this.deps.autoCreate) throw new SessionNotFoundError(quizId)
    return this.create({ quizId })
  }

  freshIfStale(actor: QuizActor): QuizActor {
    if (actor.state.phase !== 'finished' || actor.connectionCount > 0) return actor
    this.deps.logger.info(
      { quizId: actor.quizId },
      'finished session re-joined; starting a new run',
    )
    return this.restart(actor.quizId)
  }

  /** Replace a session with a fresh run under the same id (players must re-join). */
  restart(quizId: string): QuizActor {
    const old = this.actors.get(quizId)
    if (!old) throw new SessionNotFoundError(quizId)
    const definitionId = old.state.definition.id
    const rules = old.state.rules
    this.dispose(quizId)
    const state = createSession(
      quizId,
      this.resolveDefinition(definitionId),
      rules,
      this.deps.clock(),
    )
    const actor = new QuizActor(state, {
      clock: this.deps.clock,
      logger: this.deps.logger,
      metrics: this.deps.metrics,
      options: this.deps.actorOptions,
      onIdle: (a) => this.dispose(a.quizId),
      onQuizFinished: this.deps.onQuizFinished,
    })
    this.actors.set(quizId, actor)
    this.deps.metrics.sessionsActive.set(this.actors.size)
    this.deps.onCreated?.(actor)
    return actor
  }

  list(): SessionInfo[] {
    return Array.from(this.actors.values(), (a) => a.info())
  }

  dispose(quizId: string): void {
    const actor = this.actors.get(quizId)
    if (!actor) return
    this.actors.delete(quizId)
    this.deps.metrics.participants.dec(actor.state.players.size)
    actor.dispose()
    this.deps.metrics.sessionsActive.set(this.actors.size)
    this.deps.onDisposed?.(actor)
  }

  disposeAll(): void {
    for (const id of Array.from(this.actors.keys())) this.dispose(id)
  }

  private resolveDefinition(id: string | undefined): QuizDefinition {
    const first = this.deps.definitions[0]
    if (!first) throw new Error('unreachable: no definitions')
    if (id === undefined) return first
    const found = this.deps.definitions.find((d) => d.id === id)
    if (!found) throw new DefinitionNotFoundError(id)
    return found
  }

  private generateId(): string {
    // 6 chars, no 0/O/1/I ambiguity: 30^6 ≈ 729 M ids — plenty, and easy to read out loud.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    for (let attempt = 0; attempt < 10; attempt++) {
      let id = ''
      for (let i = 0; i < 6; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
      if (!this.actors.has(id)) return id
    }
    throw new Error('could not allocate a unique session id')
  }
}

function mergeRules(base: SessionRules, overrides: SessionOverrides | undefined): SessionRules {
  if (!overrides) return base
  return {
    ...base,
    ...(overrides.lobbyMs !== undefined ? { lobbyMs: overrides.lobbyMs } : {}),
    ...(overrides.questionTimeLimitMs !== undefined
      ? { questionTimeLimitMs: overrides.questionTimeLimitMs }
      : {}),
    ...(overrides.revealMs !== undefined ? { revealMs: overrides.revealMs } : {}),
    ...(overrides.endEarlyWhenAllAnswered !== undefined
      ? { endEarlyWhenAllAnswered: overrides.endEarlyWhenAllAnswered }
      : {}),
  }
}
