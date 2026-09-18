/**
 * Composition root. `createServer` wires config → dependencies → transports and returns a
 * handle that tests and the entrypoint both use, so integration tests run the real stack on
 * an ephemeral port.
 */
import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { sql } from 'kysely'
import { type QuizActor, SessionRegistry, type SessionResolver } from './actor/index.js'
import { ClusterRegistry, RedisBus } from './cluster/index.js'
import type { Config } from './config.js'
import {
  createDb,
  type Db,
  migrateToLatest,
  PostgresQuizStore,
  PostgresSessionArchive,
  type SessionArchive,
} from './db/index.js'
import { DEFAULT_RULES, type QuizDefinition } from './domain/index.js'
import { createLogger, type Logger } from './observability/logger.js'
import { createMetrics, type Metrics } from './observability/metrics.js'
import { createHttpApp } from './transport/http.js'
import { registerWebSocket } from './transport/ws.js'

export interface QuizServer {
  port: number
  url: string
  wsUrl: string
  instanceId: string
  registry: SessionRegistry
  cluster: ClusterRegistry | null
  archive: SessionArchive | null
  definitions: QuizDefinition[]
  metrics: Metrics
  logger: Logger
  close(): Promise<void>
}

export interface CreateServerOptions {
  config: Config
  /** Quiz bank fallback (and seed source) — used as-is when no database is configured. */
  definitions: QuizDefinition[]
  logger?: Logger
  clock?: () => number
}

export async function createServer(opts: CreateServerOptions): Promise<QuizServer> {
  const { config } = opts
  const instanceId = config.INSTANCE_ID ?? `i-${randomUUID().slice(0, 8)}`
  const logger = (
    opts.logger ?? createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development')
  ).child({
    instance: instanceId,
  })
  const clock = opts.clock ?? Date.now
  const metrics = createMetrics()

  // ---- persistence (optional) ------------------------------------------------------------
  let db: Db | null = null
  let archive: SessionArchive | null = null
  let definitions = opts.definitions
  if (config.DATABASE_URL) {
    db = createDb(config.DATABASE_URL)
    if (config.DB_AUTO_MIGRATE) {
      const { error, results } = await migrateToLatest(db)
      if (error) throw error instanceof Error ? error : new Error(String(error))
      for (const r of results ?? [])
        logger.info({ migration: r.migrationName, status: r.status }, 'migration')
    }
    const store = new PostgresQuizStore(db)
    let fromDb = await store.listQuizzes()
    if (fromDb.length === 0 && config.DB_AUTO_SEED) {
      await store.upsertQuizzes(opts.definitions)
      fromDb = await store.listQuizzes()
      logger.info({ quizzes: fromDb.length }, 'seeded quiz bank from data/quizzes.json')
    }
    if (fromDb.length > 0) definitions = fromDb
    archive = new PostgresSessionArchive(db)
    logger.info(
      { url: config.DATABASE_URL.replace(/\/\/.*@/, '//***@'), quizzes: definitions.length },
      'database connected',
    )
  }

  // Archive writes never block gameplay: fire-and-forget with logging.
  const persist = (what: string, p: Promise<unknown>) => {
    p.catch((err) => logger.error({ err, what }, 'archive write failed'))
  }

  // ---- sessions ---------------------------------------------------------------------------
  let cluster: ClusterRegistry | null = null
  const registry = new SessionRegistry({
    clock,
    logger,
    metrics,
    definitions,
    defaultRules: {
      ...DEFAULT_RULES,
      lobbyMs: config.LOBBY_MS,
      questionTimeLimitMs: config.QUESTION_TIME_LIMIT_MS,
      revealMs: config.REVEAL_MS,
    },
    actorOptions: {
      leaderboardIntervalMs: config.LEADERBOARD_INTERVAL_MS,
      topN: config.LEADERBOARD_TOP_N,
      idleTtlMs: config.SESSION_IDLE_TTL_MS,
    },
    autoCreate: config.AUTO_CREATE_SESSIONS,
    onCreated: (actor) => {
      void cluster?.onLocalCreated(actor)
      if (archive) {
        persist(
          'session_created',
          archive.sessionCreated(
            actor.quizId,
            actor.state.definition.id,
            actor.state.rules,
            instanceId,
          ),
        )
      }
    },
    onDisposed: (actor) => void cluster?.onLocalDisposed(actor),
    onQuizFinished: (state, standings) => {
      if (archive) persist('session_finished', archive.sessionFinished(state, standings))
    },
  })

  let bus: RedisBus | null = null
  if (config.REDIS_URL) {
    bus = new RedisBus(config.REDIS_URL, logger)
    cluster = new ClusterRegistry({
      instanceId,
      registry,
      bus,
      logger,
      leaseMs: config.SESSION_LEASE_MS,
      autoCreate: config.AUTO_CREATE_SESSIONS,
    })
    logger.info(
      { redis: config.REDIS_URL.replace(/\/\/.*@/, '//***@') },
      'cluster mode: sessions shared via Redis',
    )
  }

  const sessions: SessionResolver = cluster ?? registry
  const createSession = (
    body: Parameters<SessionRegistry['create']>[0],
  ): Promise<QuizActor> | QuizActor => (cluster ? cluster.create(body) : registry.create(body))

  if (config.DEMO_QUIZ_ID) {
    try {
      await createSession({ quizId: config.DEMO_QUIZ_ID })
    } catch (err) {
      // In a cluster another instance may already own the demo session — that is fine.
      logger.info({ err: (err as Error).message }, 'demo session not created here')
    }
  }

  // ---- transports -------------------------------------------------------------------------
  const app = createHttpApp({
    registry,
    createSession,
    logger,
    metrics,
    instanceId,
    archive,
    readiness: async () => {
      try {
        if (bus && (await bus.client.ping()) !== 'PONG') return false
        if (db) await sql`select 1`.execute(db)
        return true
      } catch {
        return false
      }
    },
  })
  const nodeWs = createNodeWebSocket({ app })
  registerWebSocket(app, nodeWs, {
    sessions,
    logger,
    metrics,
    clock,
    newUserId: () => randomUUID(),
    options: {
      backpressureBytes: config.WS_BACKPRESSURE_BYTES,
      heartbeatMs: config.WS_HEARTBEAT_MS,
      rateLimitPerSec: config.WS_RATE_LIMIT_PER_SEC,
      rateLimitBurst: config.WS_RATE_LIMIT_BURST,
    },
  })

  const server = await new Promise<HttpServer>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, () =>
      resolve(s as HttpServer),
    )
  })
  nodeWs.injectWebSocket(server)

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.PORT
  const host = config.HOST === '0.0.0.0' || config.HOST === '::' ? 'localhost' : config.HOST

  return {
    port,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    instanceId,
    registry,
    cluster,
    archive,
    definitions,
    metrics,
    logger,
    async close() {
      // Release leases first so another instance can re-home the sessions immediately.
      await cluster?.close()
      registry.disposeAll()
      for (const client of nodeWs.wss.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await bus?.close()
      await db?.destroy()
    },
  }
}
