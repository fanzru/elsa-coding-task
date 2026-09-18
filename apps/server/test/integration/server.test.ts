import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createServer, type QuizServer } from '../../src/server.js'
import { silentLogger, TEST_DEF } from '../helpers.js'
import { connect, type TestClient } from './ws-client.js'

let server: QuizServer

beforeAll(async () => {
  server = await createServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      AUTO_CREATE_SESSIONS: 'false',
      DEMO_QUIZ_ID: '',
      LOBBY_MS: '300',
      QUESTION_TIME_LIMIT_MS: '1500',
      REVEAL_MS: '150',
      LEADERBOARD_INTERVAL_MS: '50',
      WS_RATE_LIMIT_PER_SEC: '50',
      WS_RATE_LIMIT_BURST: '10',
    }),
    definitions: [TEST_DEF],
    logger: silentLogger,
  })
})
afterAll(async () => {
  await server.close()
})

const api = (path: string, init?: RequestInit) => fetch(`${server.url}${path}`, init)
const createSession = async (body: Record<string, unknown> = {}) => {
  const res = await api('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { quizId: string }
}
const join = async (quizId: string, name: string, userId?: string) => {
  const c = await connect(server.wsUrl)
  c.send({ type: 'join', quizId, name, ...(userId ? { userId } : {}) })
  const welcome = await c.next('welcome')
  return { client: c, welcome }
}

describe('REST', () => {
  it('serves health, readiness, quizzes and metrics', async () => {
    expect(await (await api('/healthz')).text()).toBe('ok')
    expect((await api('/readyz')).status).toBe(200)
    const quizzes = (await (await api('/api/quizzes')).json()) as { quizzes: { id: string }[] }
    expect(quizzes.quizzes[0]?.id).toBe('test-quiz')
    const metrics = await (await api('/metrics')).text()
    expect(metrics).toContain('quiz_ws_connections')
    expect(metrics).toContain('nodejs_eventloop_lag_seconds')
  })

  it('creates sessions with generated or custom ids and rejects duplicates / bad bodies', async () => {
    const a = await createSession()
    expect(a.quizId).toMatch(/^[A-Z2-9]{6}$/)
    const b = await createSession({ quizId: 'ROOM-1', overrides: { lobbyMs: 100 } })
    expect(b.quizId).toBe('ROOM-1')
    expect(
      (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ quizId: 'ROOM-1' }) }))
        .status,
    ).toBe(409)
    expect(
      (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ quizId: 'bad id!' }) }))
        .status,
    ).toBe(400)
    expect(
      (
        await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ quizDefinitionId: 'nope' }),
        })
      ).status,
    ).toBe(404)
    expect((await api('/api/sessions/NOPE')).status).toBe(404)
  })
})

describe('WebSocket protocol', () => {
  it('rejects malformed frames, unknown quizzes and answers before joining, without disconnecting', async () => {
    const c = await connect(server.wsUrl)
    c.sendRaw('this is not json')
    expect((await c.next('error')).code).toBe('bad_message')
    c.send({ type: 'answer', questionId: 'q1', choice: 0 })
    expect((await c.next('error')).code).toBe('not_joined')
    c.send({ type: 'join', quizId: 'DOES-NOT-EXIST', name: 'x' })
    expect((await c.next('error')).code).toBe('quiz_not_found')
    c.send({ type: 'ping' })
    expect((await c.next('pong')).serverTime).toBeGreaterThan(0)
    expect(c.ws.readyState).toBe(c.ws.OPEN)
    c.close()
  })

  it('rate-limits a flooding client', async () => {
    const c = await connect(server.wsUrl)
    for (let i = 0; i < 30; i++) c.send({ type: 'ping' })
    const err = await c.next('error')
    expect(err.code).toBe('rate_limited')
    c.close()
  })

  it('lets several users join the same quiz id, plays it through, and keeps the leaderboard live', async () => {
    const { quizId } = await createSession({
      overrides: { lobbyMs: 200, endEarlyWhenAllAnswered: false },
    })
    const ana = await join(quizId, 'Ana')
    const bo = await join(quizId, 'Bo')
    const cy = await join(quizId, 'Cy')
    expect(ana.welcome.quiz.totalQuestions).toBe(3)
    expect(ana.welcome.phase).toBe('lobby')

    // Everyone learns about the others through the coalesced leaderboard
    const lb3 = await ana.client.next('leaderboard', (m) => m.leaderboard.participants === 3)
    expect(lb3.leaderboard.top.map((e) => e.name).sort()).toEqual(['Ana', 'Bo', 'Cy'])

    // Question 1 arrives to all three (same id, no correct answer leaked)
    const [q1a, q1b, q1c] = await Promise.all([
      ana.client.next('question'),
      bo.client.next('question'),
      cy.client.next('question'),
    ])
    expect(q1a.question.id).toBe('q1')
    expect(q1b.question.id).toBe('q1')
    expect(q1c.question.id).toBe('q1')
    expect(JSON.stringify(q1a)).not.toContain('correctChoice')

    // Ana correct & fast, Bo correct & slower, Cy wrong
    ana.client.send({ type: 'answer', questionId: 'q1', choice: 1 })
    const ra = await ana.client.next('answer_result')
    expect(ra).toMatchObject({ accepted: true, correct: true, streak: 1 })
    expect(ra.points).toBeGreaterThan(900)

    // Duplicate submission (double-click / retry) is refused and does not change the score
    ana.client.send({ type: 'answer', questionId: 'q1', choice: 0 })
    expect(await ana.client.next('answer_result')).toMatchObject({
      accepted: false,
      reason: 'already_answered',
      score: ra.score,
    })

    await new Promise((r) => setTimeout(r, 300))
    bo.client.send({ type: 'answer', questionId: 'q1', choice: 1 })
    const rb = await bo.client.next('answer_result')
    expect(rb.correct).toBe(true)
    expect(rb.points ?? 0).toBeLessThan(ra.points ?? 0)

    cy.client.send({ type: 'answer', questionId: 'q1', choice: 0 })
    expect(await cy.client.next('answer_result')).toMatchObject({
      correct: false,
      points: 0,
      score: 0,
    })

    // Leaderboard reflects the standings, with each user's own rank
    const lbCy = await cy.client.next('leaderboard', (m) => (m.leaderboard.top[1]?.score ?? 0) > 0)
    expect(lbCy.leaderboard.top.map((e) => e.name)).toEqual(['Ana', 'Bo', 'Cy'])
    expect(lbCy.leaderboard.you).toMatchObject({ name: 'Cy', rank: 3 })
    const lbBo = await bo.client.next('leaderboard', (m) => m.leaderboard.you?.rank === 2)
    expect(lbBo.leaderboard.you?.name).toBe('Bo')

    // Reveal (the question runs to its deadline since end-early is off for this session)
    const end = await ana.client.next('question_end')
    expect(end).toMatchObject({ questionId: 'q1', correctChoice: 1, answered: 3, correctCount: 2 })

    // REST view agrees with the socket view
    const rest = (await (await api(`/api/sessions/${quizId}/leaderboard`)).json()) as {
      top: { name: string }[]
    }
    expect(rest.top.map((e) => e.name)).toEqual(['Ana', 'Bo', 'Cy'])

    // Let the rest of the quiz run; everybody gets the final board
    const ends = await Promise.all([
      ana.client.next('quiz_end', () => true, 10_000),
      bo.client.next('quiz_end', () => true, 10_000),
      cy.client.next('quiz_end', () => true, 10_000),
    ])
    expect(ends[0].leaderboard.top[0]?.name).toBe('Ana')
    expect(ends[2].leaderboard.you?.rank).toBe(3)
    const info = (await (await api(`/api/sessions/${quizId}`)).json()) as { phase: string }
    expect(info.phase).toBe('finished')

    for (const c of [ana, bo, cy]) c.client.close()
  }, 20_000)

  it('a user who reconnects mid-quiz keeps their score and gets a snapshot of the current question', async () => {
    const { quizId } = await createSession({
      overrides: { lobbyMs: 100, questionTimeLimitMs: 3_000, endEarlyWhenAllAnswered: false },
    })
    const first = await join(quizId, 'Ana')
    const userId = first.welcome.you.userId
    const q = await first.client.next('question')
    first.client.send({ type: 'answer', questionId: q.question.id, choice: 1 })
    const result = await first.client.next('answer_result')
    expect(result.points).toBeGreaterThan(0)

    first.client.close()
    await first.client.closed

    const again = await join(quizId, 'Ana', userId)
    expect(again.welcome.you.userId).toBe(userId)
    expect(again.welcome.phase).toBe('question')
    expect(again.welcome.question?.id).toBe(q.question.id)
    expect(again.welcome.leaderboard.you).toMatchObject({ score: result.score, rank: 1 })
    again.client.close()
  })

  it('restart gives the same code a fresh run and closes old sockets', async () => {
    const { quizId } = await createSession()
    const c = await join(quizId, 'Ana')
    const res = await api(`/api/sessions/${quizId}/restart`, { method: 'POST' })
    expect(res.status).toBe(200)
    const closed = await c.client.closed
    expect(closed.code).toBe(1001)
    const info = (await (await api(`/api/sessions/${quizId}`)).json()) as { participants: number }
    expect(info.participants).toBe(0)
  })

  it('joining a finished session that everyone has left starts a fresh run under the same code', async () => {
    const { quizId } = await createSession({
      overrides: { lobbyMs: 100, questionTimeLimitMs: 1_000, revealMs: 50 },
    })
    const first = await join(quizId, 'Ana')
    await first.client.next('quiz_end', () => true, 15_000)
    expect(server.registry.get(quizId)?.state.phase).toBe('finished')
    first.client.close()
    await first.client.closed

    const again = await join(quizId, 'Bo')
    expect(again.welcome.phase).toBe('lobby')
    expect(again.welcome.leaderboard.participants).toBe(1) // fresh run, not the old standings
    again.client.close()
  }, 20_000)

  it('start skips the lobby countdown', async () => {
    const { quizId } = await createSession({ overrides: { lobbyMs: 60_000 } })
    const c = await join(quizId, 'Ana')
    await api(`/api/sessions/${quizId}/start`, { method: 'POST' })
    const q = await c.client.next('question', () => true, 1_000)
    expect(q.question.index).toBe(0)
    c.client.close()
  })

  it('exposes the load in metrics', async () => {
    const text = await (await api('/metrics')).text()
    expect(text).toMatch(/quiz_answers_total\{result="correct"\} [1-9]/)
    expect(text).toMatch(/quiz_answers_total\{result="rejected_already_answered"\} [1-9]/)
    expect(text).toMatch(/quiz_messages_sent_total\{type="leaderboard"\} [1-9]/)
    expect(text).toMatch(/quiz_answer_processing_seconds_count [1-9]/)
  })
})

describe('auto-create mode', () => {
  let auto: QuizServer
  beforeAll(async () => {
    auto = await createServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        DEMO_QUIZ_ID: 'DEMO',
      }),
      definitions: [TEST_DEF],
      logger: silentLogger,
    })
  })
  afterAll(async () => {
    await auto.close()
  })

  it('boots with the demo session and creates unknown ids on join', async () => {
    expect((await auto.registry.list()).map((s) => s.quizId)).toEqual(['DEMO'])
    const c: TestClient = await connect(auto.wsUrl)
    c.send({ type: 'join', quizId: 'NEW-ROOM', name: 'Ana' })
    const w = await c.next('welcome')
    expect(w.quiz.id).toBe('NEW-ROOM')
    expect(auto.registry.get('NEW-ROOM')).toBeDefined()
    c.close()
  })
})
