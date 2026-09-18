/**
 * Two server instances sharing one Redis: a session created on A is joined through B.
 * Skipped unless REDIS_URL is set (e.g. `docker run --rm -p 6390:6379 redis:7-alpine`).
 */
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createServer, type QuizServer } from '../../src/server.js'
import { silentLogger, TEST_DEF } from '../helpers.js'
import { connect } from './ws-client.js'

const REDIS_URL = process.env.REDIS_URL
const describeIf = REDIS_URL ? describe : describe.skip

describeIf('cluster mode (two instances, one Redis)', () => {
  let a: QuizServer
  let b: QuizServer
  const boot = (id: string) =>
    createServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        AUTO_CREATE_SESSIONS: 'false',
        DEMO_QUIZ_ID: '',
        REDIS_URL,
        INSTANCE_ID: id,
        SESSION_LEASE_MS: '2000',
        LOBBY_MS: '300',
        QUESTION_TIME_LIMIT_MS: '2000',
        REVEAL_MS: '150',
        LEADERBOARD_INTERVAL_MS: '50',
      }),
      definitions: [TEST_DEF],
      logger: silentLogger,
    })

  beforeAll(async () => {
    a = await boot(`A-${process.pid}`)
    b = await boot(`B-${process.pid}`)
  })
  afterAll(async () => {
    await a.close()
    await b.close()
  })

  const unique = () => `CL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

  it('serves a join on B for a session owned by A, with scoring done by A', async () => {
    const quizId = unique()
    const res = await fetch(`${a.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quizId, overrides: { lobbyMs: 300, endEarlyWhenAllAnswered: false } }),
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('x-instance-id')).toBe(a.instanceId)

    // Ana connects to A (owner), Bo connects to B (gateway)
    const ana = await connect(a.wsUrl)
    ana.send({ type: 'join', quizId, name: 'Ana' })
    const wa = await ana.next('welcome')
    const bo = await connect(b.wsUrl)
    bo.send({ type: 'join', quizId, name: 'Bo' })
    const wb = await bo.next('welcome')
    expect(wb.quiz.id).toBe(quizId)
    expect(wb.leaderboard.participants).toBe(2)
    expect(a.registry.get(quizId)?.state.players.size).toBe(2)
    expect(b.registry.get(quizId)).toBeUndefined() // B holds no state for it

    // Both receive the question; Bo (via B) answers and gets a result computed on A
    const [qa, qb] = await Promise.all([ana.next('question'), bo.next('question')])
    expect(qb.question.id).toBe(qa.question.id)
    bo.send({ type: 'answer', questionId: qb.question.id, choice: 1 })
    const rb = await bo.next('answer_result')
    expect(rb).toMatchObject({ accepted: true, correct: true })
    expect(rb.points).toBeGreaterThan(0)

    // Ana (on A) sees Bo on top; Bo (on B) sees himself with rank 1
    const la = await ana.next('leaderboard', (m) => (m.leaderboard.top[0]?.score ?? 0) > 0)
    expect(la.leaderboard.top[0]?.name).toBe('Bo')
    const lb = await bo.next('leaderboard', (m) => m.leaderboard.you?.rank === 1)
    expect(lb.leaderboard.you?.name).toBe('Bo')

    // Duplicate through the gateway is refused just like a local one
    bo.send({ type: 'answer', questionId: qb.question.id, choice: 0 })
    expect(await bo.next('answer_result')).toMatchObject({
      accepted: false,
      reason: 'already_answered',
    })

    expect(wa.you.userId).not.toBe(wb.you.userId)
    ana.close()
    bo.close()
  })

  it('refuses to create the same session id on two instances', async () => {
    const quizId = unique()
    const first = await fetch(`${b.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quizId }),
    })
    expect(first.status).toBe(201)
    const second = await fetch(`${a.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quizId }),
    })
    expect(second.status).toBe(409)
  })

  it('re-homes a session on another instance after its owner disappears', async () => {
    const quizId = unique()
    const c = await boot(`C-${process.pid}`)
    const res = await fetch(`${c.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quizId, overrides: { lobbyMs: 60_000 } }),
    })
    expect(res.status).toBe(201)
    await c.close() // releases the lease

    const client = await connect(b.wsUrl)
    client.send({ type: 'join', quizId, name: 'Ana' })
    const w = await client.next('welcome')
    expect(w.quiz.id).toBe(quizId)
    expect(b.registry.get(quizId)).toBeDefined() // recreated locally from Redis metadata
    expect(b.registry.get(quizId)?.state.rules.lobbyMs).toBe(60_000) // with its overrides
    client.close()
  })

  it('bounces clients of a crashed owner (lease not released) and re-homes after the lease lapses', async () => {
    const quizId = unique()
    // Simulate an owner that died mid-lease: the directory says "ghost" owns it for 1.5 s.
    const redis = new Redis(REDIS_URL as string)
    await redis.set(`quiz:${quizId}:owner`, 'ghost', 'PX', 1_500)
    await redis.set(`quiz:${quizId}:meta`, JSON.stringify({ definitionId: TEST_DEF.id }))
    await redis.quit()

    const first = await connect(b.wsUrl)
    first.send({ type: 'join', quizId, name: 'Ana' })
    const closed = await first.closed // owner never answers → bounced
    expect(closed.code).toBe(1012)

    // Client reconnects (what the web client does automatically); by now the lease has lapsed.
    const second = await connect(b.wsUrl)
    second.send({ type: 'join', quizId, name: 'Ana' })
    const w = await second.next('welcome')
    expect(w.quiz.id).toBe(quizId)
    expect(b.registry.get(quizId)).toBeDefined()
    second.close()
  }, 15_000)

  it('keeps serving gateways after the owner restarts a session', async () => {
    const quizId = unique()
    await fetch(`${a.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quizId, overrides: { lobbyMs: 60_000 } }),
    })
    const viaB = await connect(b.wsUrl)
    viaB.send({ type: 'join', quizId, name: 'Bo' })
    await viaB.next('welcome')

    const res = await fetch(`${a.url}/api/sessions/${quizId}/restart`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await viaB.closed).code).toBe(1001) // old run closed through the gateway

    // A fresh join through B reaches the restarted actor on A (lease re-claimed, inbox re-served)
    const viaB2 = await connect(b.wsUrl)
    viaB2.send({ type: 'join', quizId, name: 'Bo' })
    const w = await viaB2.next('welcome')
    expect(w.phase).toBe('lobby')
    expect(a.registry.get(quizId)?.state.players.size).toBe(1)
    viaB2.close()
  })

  it('reports readiness from Redis', async () => {
    expect((await fetch(`${a.url}/readyz`)).status).toBe(200)
  })
})
