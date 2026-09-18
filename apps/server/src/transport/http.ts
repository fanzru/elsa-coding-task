/**
 * REST surface. Deliberately small: session lifecycle for the demo UI and load generator,
 * a polling fallback for the leaderboard, and the operational endpoints.
 */
import { CreateSessionRequest, type QuizSummary } from '@quiz/protocol'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  type QuizActor,
  SessionExistsError,
  SessionNotFoundError,
  type SessionRegistry,
} from '../actor/index.js'
import { DefinitionNotFoundError } from '../actor/registry.js'
import type { SessionArchive } from '../db/repository.js'
import type { Logger } from '../observability/logger.js'
import type { Metrics } from '../observability/metrics.js'

export interface HttpDeps {
  registry: SessionRegistry
  /** Session creation goes through the cluster layer when one is configured. */
  createSession: (body: CreateSessionRequest) => Promise<QuizActor> | QuizActor
  logger: Logger
  metrics: Metrics
  readiness: () => Promise<boolean>
  instanceId: string
  /** Present when a database is configured. */
  archive: SessionArchive | null
}

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono()
  app.use('/api/*', cors())

  app.use('*', async (c, next) => {
    c.header('x-instance-id', deps.instanceId)
    await next()
  })

  app.get('/healthz', (c) => c.text('ok'))
  app.get('/readyz', async (c) =>
    (await deps.readiness()) ? c.text('ready') : c.text('not ready', 503),
  )
  app.get('/metrics', async (c) => {
    c.header('Content-Type', deps.metrics.registry.contentType)
    return c.body(await deps.metrics.registry.metrics())
  })

  app.get('/api/quizzes', (c) => {
    const quizzes: QuizSummary[] = deps.registry.definitions.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      totalQuestions: d.questions.length,
    }))
    return c.json({ quizzes })
  })

  app.get('/api/sessions', (c) => c.json({ sessions: deps.registry.list() }))

  app.post('/api/sessions', async (c) => {
    const body = CreateSessionRequest.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: 'invalid body', issues: body.error.issues }, 400)
    try {
      const actor = await deps.createSession(body.data)
      return c.json(actor.info(), 201)
    } catch (err) {
      if (err instanceof SessionExistsError) return c.json({ error: err.message }, 409)
      if (err instanceof DefinitionNotFoundError) return c.json({ error: err.message }, 404)
      throw err
    }
  })

  app.get('/api/sessions/:quizId', (c) => {
    const actor = deps.registry.get(c.req.param('quizId'))
    return actor ? c.json(actor.info()) : c.json({ error: 'not found' }, 404)
  })

  app.get('/api/sessions/:quizId/leaderboard', (c) => {
    const actor = deps.registry.get(c.req.param('quizId'))
    return actor ? c.json(actor.leaderboard()) : c.json({ error: 'not found' }, 404)
  })

  app.post('/api/sessions/:quizId/start', (c) => {
    const actor = deps.registry.get(c.req.param('quizId'))
    if (!actor) return c.json({ error: 'not found' }, 404)
    actor.start()
    return c.json(actor.info())
  })

  // Archived data (Postgres). Live state above never touches the database.
  app.get('/api/history', async (c) => {
    if (!deps.archive) return c.json({ error: 'no database configured' }, 501)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20) || 20))
    return c.json({ sessions: await deps.archive.recentSessions(limit) })
  })

  app.get('/api/sessions/:quizId/results', async (c) => {
    if (!deps.archive) return c.json({ error: 'no database configured' }, 501)
    const view = await deps.archive.results(c.req.param('quizId'))
    return view ? c.json(view) : c.json({ error: 'not found' }, 404)
  })

  app.post('/api/sessions/:quizId/restart', (c) => {
    try {
      return c.json(deps.registry.restart(c.req.param('quizId')).info())
    } catch (err) {
      if (err instanceof SessionNotFoundError) return c.json({ error: err.message }, 404)
      throw err
    }
  })

  app.onError((err, c) => {
    deps.logger.error({ err, path: c.req.path }, 'unhandled http error')
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
