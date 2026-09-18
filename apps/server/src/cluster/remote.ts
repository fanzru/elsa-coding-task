/**
 * Cross-instance plumbing for one session.
 *
 *   gateway instance                              owner instance
 *   ────────────────                              ──────────────
 *   RemoteSession.join/answer/detach ──PUBLISH──▶ quiz:{id}:inbox ──▶ QuizActor (via RemoteConnection)
 *   local sockets ◀── quiz:{id}:gw:{gateway} ◀──PUBLISH── RemoteGateway (batched per flush)
 *
 * The actor is unaware of any of this: a RemoteConnection is just a `Connection` whose `send`
 * buffers into the gateway's outbound batch instead of writing to a socket.
 */

import type { Connection } from '../actor/connection.js'
import type { QuizActor } from '../actor/quiz-actor.js'
import type { Logger } from '../observability/logger.js'
import type { Bus } from './bus.js'

export const inboxChannel = (quizId: string) => `quiz:${quizId}:inbox`
export const gatewayChannel = (quizId: string, gatewayId: string) =>
  `quiz:${quizId}:gw:${gatewayId}`

type InboxCommand =
  | { t: 'join'; gw: string; c: string; name: string; userId: string; lastSeq?: number }
  | { t: 'answer'; gw: string; c: string; questionId: string; choice: number }
  | { t: 'detach'; gw: string; c: string }

/** Owner side: one per (session, gateway instance). Batches outbound deliveries per tick. */
export class RemoteGateway {
  private pending: Array<[string, string, 0 | 1]> = []
  private scheduled = false
  readonly conns = new Map<string, RemoteConnection>()

  constructor(
    readonly quizId: string,
    readonly gatewayId: string,
    private readonly bus: Bus,
    private readonly log: Logger,
  ) {}

  connection(connId: string): RemoteConnection {
    let c = this.conns.get(connId)
    if (!c) {
      c = new RemoteConnection(connId, this)
      this.conns.set(connId, c)
    }
    return c
  }

  enqueue(connId: string, json: string, droppable: boolean): void {
    this.pending.push([connId, json, droppable ? 1 : 0])
    if (this.scheduled) return
    this.scheduled = true
    // One publish per gateway per event-loop turn, however many connections were written to.
    setImmediate(() => {
      this.scheduled = false
      const batch = this.pending
      this.pending = []
      this.bus
        .publish(gatewayChannel(this.quizId, this.gatewayId), JSON.stringify(batch))
        .catch((err) =>
          this.log.warn({ err, gateway: this.gatewayId }, 'failed to publish to gateway'),
        )
    })
  }
}

export class RemoteConnection implements Connection {
  userId: string | null = null
  constructor(
    private readonly connId: string,
    private readonly gateway: RemoteGateway,
  ) {}
  get id(): string {
    return `${this.gateway.gatewayId}:${this.connId}`
  }
  send(json: string, opts: { droppable: boolean }): boolean {
    this.gateway.enqueue(this.connId, json, opts.droppable)
    return true
  }
  close(_code: number, _reason: string): void {
    // The gateway closes the real socket when it learns the session is gone; nothing to do here.
    this.gateway.enqueue(this.connId, '', false)
  }
}

/** Owner side: subscribe to the session inbox and drive the local actor. */
export async function serveInbox(
  actor: QuizActor,
  bus: Bus,
  log: Logger,
): Promise<() => Promise<void>> {
  const gateways = new Map<string, RemoteGateway>()
  const gateway = (id: string) => {
    let g = gateways.get(id)
    if (!g) {
      g = new RemoteGateway(actor.quizId, id, bus, log)
      gateways.set(id, g)
    }
    return g
  }
  return bus.subscribe(inboxChannel(actor.quizId), (payload) => {
    if (actor.isDisposed) return
    let cmd: InboxCommand
    try {
      cmd = JSON.parse(payload) as InboxCommand
    } catch {
      return
    }
    const g = gateway(cmd.gw)
    switch (cmd.t) {
      case 'join':
        actor.join(g.connection(cmd.c), cmd.name, cmd.userId, cmd.lastSeq)
        return
      case 'answer': {
        const conn = g.conns.get(cmd.c)
        if (conn) actor.answer(conn, cmd.questionId, cmd.choice)
        return
      }
      case 'detach': {
        const conn = g.conns.get(cmd.c)
        if (conn) {
          actor.detach(conn)
          g.conns.delete(cmd.c)
        }
        return
      }
    }
  })
}

/** How long a gateway waits for the owner to answer a join before declaring it dead. */
export const OWNER_TIMEOUT_MS = 3_000

/** Gateway side: looks like a session to the transport, forwards everything to the owner. */
export class RemoteSession {
  private readonly conns = new Map<string, Connection>()
  private readonly pendingJoins = new Map<string, NodeJS.Timeout>()
  private unsubscribe: (() => Promise<void>) | null = null

  constructor(
    readonly quizId: string,
    private readonly gatewayId: string,
    private readonly bus: Bus,
    private readonly log: Logger,
    private readonly onEmpty: (s: RemoteSession) => void,
    private readonly onOwnerDead: (s: RemoteSession) => void,
  ) {}

  async open(): Promise<void> {
    this.unsubscribe = await this.bus.subscribe(
      gatewayChannel(this.quizId, this.gatewayId),
      (payload) => {
        let batch: Array<[string, string, 0 | 1]>
        try {
          batch = JSON.parse(payload) as Array<[string, string, 0 | 1]>
        } catch {
          return
        }
        for (const [connId, json, droppable] of batch) {
          const conn = this.conns.get(connId)
          if (!conn) continue
          this.clearPending(connId) // any delivery proves the owner is alive
          if (json === '') conn.close(1001, 'session closed')
          else conn.send(json, { droppable: droppable === 1 })
        }
      },
    )
  }

  get connectionCount(): number {
    return this.conns.size
  }

  join(conn: Connection, name: string, userId: string, lastSeq?: number): void {
    conn.userId = userId
    this.conns.set(conn.id, conn)
    this.send({
      t: 'join',
      gw: this.gatewayId,
      c: conn.id,
      name,
      userId,
      ...(lastSeq !== undefined ? { lastSeq } : {}),
    })
    // If the owner never answers, it is gone (crashed before its lease expired). Bounce every
    // socket with 1012 "service restart": clients reconnect, and the next resolve re-homes the
    // session once the lease has lapsed.
    this.clearPending(conn.id)
    this.pendingJoins.set(
      conn.id,
      setTimeout(() => {
        this.pendingJoins.delete(conn.id)
        if (!this.conns.has(conn.id)) return
        this.log.warn({ quizId: this.quizId }, 'owner did not answer a join; treating it as dead')
        this.onOwnerDead(this)
        for (const c of this.conns.values()) c.close(1012, 'session owner unavailable')
        this.conns.clear()
      }, OWNER_TIMEOUT_MS),
    )
  }

  answer(conn: Connection, questionId: string, choice: number): void {
    this.send({ t: 'answer', gw: this.gatewayId, c: conn.id, questionId, choice })
  }

  detach(conn: Connection): void {
    this.clearPending(conn.id)
    if (!this.conns.delete(conn.id)) return
    this.send({ t: 'detach', gw: this.gatewayId, c: conn.id })
    if (this.conns.size === 0) this.onEmpty(this)
  }

  async close(): Promise<void> {
    for (const t of this.pendingJoins.values()) clearTimeout(t)
    this.pendingJoins.clear()
    await this.unsubscribe?.()
    this.unsubscribe = null
  }

  private clearPending(connId: string): void {
    const t = this.pendingJoins.get(connId)
    if (!t) return
    clearTimeout(t)
    this.pendingJoins.delete(connId)
  }

  private send(cmd: InboxCommand): void {
    this.bus
      .publish(inboxChannel(this.quizId), JSON.stringify(cmd))
      .catch((err) => this.log.warn({ err, quizId: this.quizId }, 'failed to forward to owner'))
  }
}
