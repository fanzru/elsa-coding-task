/**
 * ClusterRegistry — makes a session reachable from any instance.
 *
 * Every instance keeps its own SessionRegistry (local actors). This wrapper adds a shared
 * directory in Redis so that a join arriving at instance B for a session owned by instance A
 * is served by a RemoteSession proxy on B that forwards to A. The first instance to claim a
 * session's lease owns it; leases are renewed while the actor lives and released on dispose.
 *
 * Trade-off (documented in docs/DESIGN.md): all scoring for one session still runs on one
 * instance — that is the point (single writer). Gateways only add connection capacity.
 *
 * AI-assisted (Claude Code): the lease-release ordering bug and the missing crashed-owner
 * detection were caught by the cluster tests. See docs/AI_COLLABORATION.md #8.
 */
import type { SessionInfo } from '@quiz/protocol'
import type { QuizActor, SessionHandle, SessionRegistry, SessionResolver } from '../actor/index.js'
import { SessionExistsError, SessionNotFoundError } from '../actor/index.js'
import type { CreateOptions } from '../actor/registry.js'
import type { Logger } from '../observability/logger.js'
import type { RedisBus } from './bus.js'
import { SessionDirectory } from './directory.js'
import { RemoteSession, serveInbox } from './remote.js'

export interface ClusterDeps {
  instanceId: string
  registry: SessionRegistry
  bus: RedisBus
  logger: Logger
  leaseMs: number
  autoCreate: boolean
}

export class ClusterRegistry implements SessionResolver {
  private readonly directory: SessionDirectory
  private readonly remotes = new Map<string, RemoteSession>()
  private readonly owned = new Map<string, { stop: (force?: boolean) => Promise<void> }>()
  private readonly log: Logger

  constructor(private readonly deps: ClusterDeps) {
    this.directory = new SessionDirectory(deps.bus.client, deps.instanceId, deps.leaseMs)
    this.log = deps.logger.child({ instanceId: deps.instanceId })
  }

  get local(): SessionRegistry {
    return this.deps.registry
  }

  /** Create a session here and register ownership; fails if any instance already owns the id. */
  async create(opts: CreateOptions = {}): Promise<QuizActor> {
    if (opts.quizId && (await this.directory.owner(opts.quizId)))
      throw new SessionExistsError(opts.quizId)
    const actor = this.deps.registry.create(opts)
    if (!(await this.directory.claim(actor.quizId))) {
      this.deps.registry.dispose(actor.quizId)
      throw new SessionExistsError(actor.quizId)
    }
    await this.directory.putMeta(actor.quizId, {
      definitionId: actor.state.definition.id,
      overrides: opts.overrides,
    })
    await this.onLocalCreated(actor)
    return actor
  }

  async resolveForJoin(quizId: string): Promise<SessionHandle> {
    const local = this.deps.registry.get(quizId)
    if (local) return this.deps.registry.freshIfStale(local)
    const remote = this.remotes.get(quizId)
    if (remote) return remote

    const owner = await this.directory.owner(quizId)
    if (owner && owner !== this.deps.instanceId) return this.openRemote(quizId, owner)

    // Nobody owns it: either it never existed, or its owner went away. Recreate from metadata
    // when we can, or from scratch when auto-create is on.
    const meta = await this.directory.getMeta(quizId)
    if (!meta && !this.deps.autoCreate) throw new SessionNotFoundError(quizId)
    if (await this.directory.claim(quizId)) {
      const actor = this.deps.registry.create({
        quizId,
        quizDefinitionId: meta?.definitionId,
        overrides: meta?.overrides,
      })
      if (!meta) await this.directory.putMeta(quizId, { definitionId: actor.state.definition.id })
      await this.onLocalCreated(actor)
      this.log.info(
        { quizId, recovered: Boolean(meta) },
        meta ? 'session re-homed on this instance' : 'session auto-created',
      )
      return actor
    }
    // Lost the race — someone else just claimed it.
    const winner = await this.directory.owner(quizId)
    if (!winner) throw new SessionNotFoundError(quizId)
    return this.openRemote(quizId, winner)
  }

  info(): SessionInfo[] {
    return this.deps.registry.list()
  }

  async close(): Promise<void> {
    for (const [quizId, o] of this.owned) {
      await o.stop(true) // shutting down: always give the lease up
      this.owned.delete(quizId)
    }
    for (const r of this.remotes.values()) await r.close()
    this.remotes.clear()
  }

  /**
   * Called by the local registry for every actor it creates — including restarts, which
   * bypass `create()`. Idempotent: an actor we already serve is left alone.
   */
  async onLocalCreated(actor: QuizActor): Promise<void> {
    if (this.owned.has(actor.quizId) || actor.isDisposed) return
    if (!(await this.directory.claim(actor.quizId))) {
      this.log.error(
        { quizId: actor.quizId },
        'session is owned by another instance; disposing local copy',
      )
      this.deps.registry.dispose(actor.quizId)
      return
    }
    await this.takeOwnership(actor)
  }

  /** Called by the local registry when an actor is disposed (idle, restart, shutdown). */
  async onLocalDisposed(actor: QuizActor): Promise<void> {
    const o = this.owned.get(actor.quizId)
    if (!o) return
    this.owned.delete(actor.quizId)
    await o.stop()
  }

  private async takeOwnership(actor: QuizActor): Promise<void> {
    if (this.owned.has(actor.quizId)) return
    this.owned.set(actor.quizId, { stop: async () => undefined }) // reserve while subscribing
    const unsubscribe = await serveInbox(actor, this.deps.bus, this.log)
    const heartbeat = setInterval(
      async () => {
        const ok = await this.directory.renew(actor.quizId).catch(() => false)
        if (ok || actor.isDisposed) return
        // Lease lost (Redis outage longer than the lease, or a split). Another instance may now
        // own this id, so stop serving it here; clients reconnect and land on the new owner.
        this.log.error({ quizId: actor.quizId }, 'lost session lease; disposing local actor')
        clearInterval(heartbeat)
        this.deps.registry.dispose(actor.quizId)
      },
      Math.max(250, Math.floor(this.deps.leaseMs / 3)),
    )
    this.owned.set(actor.quizId, {
      stop: async (force = false) => {
        clearInterval(heartbeat)
        await unsubscribe()
        // A restart replaces the actor under the same code on this instance and re-claims the
        // lease; releasing here would delete the successor's lease.
        if (force || !this.deps.registry.get(actor.quizId)) {
          await this.directory.release(actor.quizId).catch(() => undefined)
        }
      },
    })
  }

  private async openRemote(quizId: string, owner: string): Promise<RemoteSession> {
    const existing = this.remotes.get(quizId)
    if (existing) return existing
    const drop = (s: RemoteSession) => {
      this.remotes.delete(s.quizId)
      void s.close()
    }
    const remote = new RemoteSession(
      quizId,
      this.deps.instanceId,
      this.deps.bus,
      this.log,
      drop,
      drop,
    )
    await remote.open()
    this.remotes.set(quizId, remote)
    this.log.info({ quizId, owner }, 'proxying session to its owner')
    return remote
  }
}
