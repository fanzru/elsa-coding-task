/**
 * WebSocket transport: one handler per socket that (1) validates every inbound frame against
 * the shared protocol, (2) rate-limits it, (3) routes it to the session actor, and (4) exposes
 * the socket to the actor through the `Connection` interface with backpressure awareness.
 *
 * AI-assisted (Claude Code): see docs/AI_COLLABORATION.md #5.
 */
import type { NodeWebSocket } from '@hono/node-ws'
import { type ClientMessage, type ErrorMessage, parseClientMessage } from '@quiz/protocol'
import type { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import type { WebSocket } from 'ws'
import type { Connection, SessionHandle, SessionResolver } from '../actor/index.js'
import { DefinitionNotFoundError, SessionNotFoundError } from '../actor/index.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'
import { TokenBucket } from './rate-limit.js'

export interface WsDeps {
  sessions: SessionResolver
  logger: Logger
  metrics: Metrics
  clock: () => number
  newUserId: () => string
  options: {
    backpressureBytes: number
    heartbeatMs: number
    rateLimitPerSec: number
    rateLimitBurst: number
  }
}

let nextConnId = 1

class SocketConnection implements Connection {
  readonly id = `c${nextConnId++}`
  userId: string | null = null

  constructor(
    private readonly ws: WSContext<WebSocket>,
    private readonly raw: WebSocket,
    private readonly deps: WsDeps,
  ) {}

  send(json: string, opts: { droppable: boolean }): boolean {
    if (this.raw.readyState !== this.raw.OPEN) {
      this.deps.metrics.messagesDropped.inc({ reason: 'socket_closed' })
      return false
    }
    if (opts.droppable && this.raw.bufferedAmount > this.deps.options.backpressureBytes) {
      this.deps.metrics.messagesDropped.inc({ reason: 'backpressure' })
      return false
    }
    this.ws.send(json)
    return true
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason)
  }
}

export function registerWebSocket(app: Hono, nodeWs: NodeWebSocket, deps: WsDeps): void {
  app.get(
    '/ws',
    nodeWs.upgradeWebSocket(() => {
      // Per-socket state lives in this closure; the actor never sees the raw socket.
      let conn: SocketConnection | null = null
      let session: SessionHandle | null = null
      let bucket: TokenBucket | null = null
      // Frames are processed strictly in arrival order even though resolving a session may be
      // async (cluster lookup): an answer can never overtake the join that precedes it.
      let queue: Promise<void> = Promise.resolve()
      let alive = true
      let heartbeat: NodeJS.Timeout | null = null
      let log = deps.logger

      const sendError = (ws: WSContext<WebSocket>, code: ErrorMessage['code'], message: string) => {
        deps.metrics.clientErrors.inc({ code })
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'error', code, message } satisfies ErrorMessage))
      }

      const handle = async (ws: WSContext<WebSocket>, msg: ClientMessage) => {
        if (!conn) return
        switch (msg.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong', serverTime: deps.clock() }))
            return
          case 'join': {
            let target: SessionHandle
            try {
              target = await deps.sessions.resolveForJoin(msg.quizId)
            } catch (err) {
              if (err instanceof SessionNotFoundError || err instanceof DefinitionNotFoundError) {
                sendError(ws, 'quiz_not_found', `quiz "${msg.quizId}" does not exist`)
                return
              }
              throw err
            }
            if (!conn) return // socket closed while we were resolving
            if (session && session !== target) session.detach(conn)
            session = target
            const userId = msg.userId ?? deps.newUserId()
            log = deps.logger.child({ connId: conn.id, quizId: msg.quizId, userId })
            session.join(conn, msg.name, userId, msg.lastSeq)
            log.debug({ name: msg.name, reconnect: msg.userId !== undefined }, 'joined')
            return
          }
          case 'answer':
            if (!session || !conn.userId) {
              sendError(ws, 'not_joined', 'send a join message first')
              return
            }
            session.answer(conn, msg.questionId, msg.choice)
            return
        }
      }

      return {
        onOpen(_evt, ws) {
          const raw = ws.raw
          if (!raw) {
            ws.close(1011, 'no raw socket')
            return
          }
          conn = new SocketConnection(ws, raw, deps)
          bucket = new TokenBucket(
            deps.options.rateLimitPerSec,
            deps.options.rateLimitBurst,
            deps.clock(),
          )
          deps.metrics.wsConnections.inc()

          // Liveness: ws-level ping/pong is handled by the browser automatically, so a client
          // that silently vanished (mobile radio off) is reaped after one missed interval.
          raw.on('pong', () => {
            alive = true
          })
          heartbeat = setInterval(() => {
            if (!alive) {
              raw.terminate()
              return
            }
            alive = false
            raw.ping()
          }, deps.options.heartbeatMs)
        },

        onMessage(evt, ws) {
          if (!conn || !bucket) return
          if (!bucket.take(deps.clock())) {
            sendError(ws, 'rate_limited', 'too many messages')
            return
          }
          if (typeof evt.data !== 'string') {
            sendError(ws, 'bad_message', 'text frames only')
            return
          }
          const msg = parseClientMessage(evt.data)
          if (!msg) {
            sendError(ws, 'bad_message', 'malformed message')
            return
          }
          queue = queue.then(() =>
            handle(ws, msg).catch((err: unknown) => {
              // One bad frame must never take down the process, nor the session.
              log.error({ err, type: msg.type }, 'unhandled error processing message')
              sendError(ws, 'internal', 'internal error')
            }),
          )
        },

        onClose() {
          if (heartbeat) clearInterval(heartbeat)
          if (conn) {
            deps.metrics.wsConnections.dec()
            session?.detach(conn)
          }
          conn = null
          session = null
        },

        onError(evt) {
          log.warn({ evt }, 'websocket error')
        },
      }
    }),
  )
}
