/**
 * Postgres archive: migrations, seed, and end-to-end persistence of a finished session.
 * Skipped unless DATABASE_URL is set (e.g. `make pg-up` → postgres://quiz:quiz@127.0.0.1:5439/quiz_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createDb, createMigrator, type Db, PostgresQuizStore } from '../../src/db/index.js'
import { createServer, type QuizServer } from '../../src/server.js'
import { silentLogger, TEST_DEF } from '../helpers.js'
import { connect } from './ws-client.js'

const DATABASE_URL = process.env.DATABASE_URL
const describeIf = DATABASE_URL ? describe : describe.skip

describeIf('postgres archive', () => {
  let db: Db
  let server: QuizServer

  beforeAll(async () => {
    db = createDb(DATABASE_URL as string, { max: 2 })
    // Start from a clean schema so the test is self-contained and repeatable.
    const migrator = createMigrator(db)
    let step = await migrator.migrateDown()
    while (step.results?.length) step = await migrator.migrateDown()
    server = await createServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
        DEMO_QUIZ_ID: '',
        DATABASE_URL,
        LOBBY_MS: '200',
        QUESTION_TIME_LIMIT_MS: '1500',
        REVEAL_MS: '100',
      }),
      definitions: [TEST_DEF],
      logger: silentLogger,
    })
  })
  afterAll(async () => {
    await server.close()
    await db.destroy()
  })

  it('migrates and seeds the quiz bank at boot, and serves quizzes from the database', async () => {
    const store = new PostgresQuizStore(db)
    const quizzes = await store.listQuizzes()
    expect(quizzes.map((q) => q.id)).toEqual([TEST_DEF.id])
    expect(quizzes[0]?.questions.map((q) => q.id)).toEqual(TEST_DEF.questions.map((q) => q.id))
    expect(server.definitions).toEqual(quizzes)

    // Seeding again is idempotent (upsert + replace questions)
    await store.upsertQuizzes([{ ...TEST_DEF, title: 'Renamed' }])
    expect((await store.listQuizzes())[0]?.title).toBe('Renamed')
    expect(
      await db
        .selectFrom('questions')
        .select(db.fn.countAll<number>().as('n'))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      n: expect.anything(),
    })
  })

  it('archives a session when it is created and its standings when it finishes', async () => {
    const res = await fetch(`${server.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quizId: 'DBTEST',
        overrides: { lobbyMs: 200, endEarlyWhenAllAnswered: true },
      }),
    })
    expect(res.status).toBe(201)

    // eventually-consistent write: poll briefly
    await waitFor(
      async () =>
        (await db
          .selectFrom('sessions')
          .selectAll()
          .where('code', '=', 'DBTEST')
          .executeTakeFirst()) !== undefined,
    )
    const created = await db
      .selectFrom('sessions')
      .selectAll()
      .where('code', '=', 'DBTEST')
      .executeTakeFirstOrThrow()
    expect(created).toMatchObject({
      quiz_id: TEST_DEF.id,
      status: 'created',
      instance_id: server.instanceId,
    })
    expect(created.rules.lobbyMs).toBe(200)

    const ana = await connect(server.wsUrl)
    ana.send({ type: 'join', quizId: 'DBTEST', name: 'Ana' })
    const w = await ana.next('welcome')
    const bo = await connect(server.wsUrl)
    bo.send({ type: 'join', quizId: 'DBTEST', name: 'Bo' })
    await bo.next('welcome')

    for (const q of TEST_DEF.questions) {
      await ana.next('question', (m) => m.question.id === q.id, 10_000)
      ana.send({ type: 'answer', questionId: q.id, choice: q.correctChoice })
      await bo.next('question', (m) => m.question.id === q.id, 10_000)
      bo.send({
        type: 'answer',
        questionId: q.id,
        choice: (q.correctChoice + 1) % q.options.length,
      })
    }
    const end = await ana.next('quiz_end', () => true, 15_000)
    expect(end.leaderboard.top[0]?.name).toBe('Ana')

    await waitFor(async () => {
      const s = await db
        .selectFrom('sessions')
        .select('status')
        .where('code', '=', 'DBTEST')
        .executeTakeFirst()
      return s?.status === 'finished'
    })
    const results = await db
      .selectFrom('session_results')
      .selectAll()
      .where('session_code', '=', 'DBTEST')
      .orderBy('rank')
      .execute()
    expect(results.map((r) => [r.rank, r.name, r.streak])).toEqual([
      [1, 'Ana', 3],
      [2, 'Bo', 0],
    ])
    expect(results[0]?.user_id).toBe(w.you.userId)
    expect(results[0]?.score).toBe(end.leaderboard.top[0]?.score)
    expect(Object.keys(results[0]?.answers ?? {})).toEqual(TEST_DEF.questions.map((q) => q.id))

    // REST view of the archive
    const view = (await (await fetch(`${server.url}/api/sessions/DBTEST/results`)).json()) as {
      status: string
      standings: { name: string }[]
    }
    expect(view.status).toBe('finished')
    expect(view.standings.map((s) => s.name)).toEqual(['Ana', 'Bo'])
    const history = (await (await fetch(`${server.url}/api/history`)).json()) as {
      sessions: { code: string; participants: number }[]
    }
    expect(history.sessions[0]).toMatchObject({ code: 'DBTEST', participants: 2 })

    // Restarting the same code resets its archive row
    await fetch(`${server.url}/api/sessions/DBTEST/restart`, { method: 'POST' })
    await waitFor(async () => {
      const s = await db
        .selectFrom('sessions')
        .select('status')
        .where('code', '=', 'DBTEST')
        .executeTakeFirst()
      return s?.status === 'created'
    })
    expect(
      await db
        .selectFrom('session_results')
        .selectAll()
        .where('session_code', '=', 'DBTEST')
        .execute(),
    ).toEqual([])
    ana.close()
    bo.close()
  }, 30_000)

  it('stores accounts in postgres, unique case-insensitively', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post('/api/auth/register', { username: 'Dana', password: 'correct horse' })).status).toBe(201)
    expect((await post('/api/auth/register', { username: 'DANA', password: 'correct horse' })).status).toBe(409)
    const login = await post('/api/auth/login', { username: 'dana', password: 'correct horse' })
    expect(login.status).toBe(200)
    expect(await db.selectFrom('users').select('username').execute()).toEqual([{ username: 'Dana' }])

    // One finished session as Dana → ranked board derived from session_results
    const { token, user } = (await login.json()) as { token: string; user: { id: string } }
    const created = await post('/api/sessions', {
      quizId: 'RANKED',
      overrides: { lobbyMs: 100, questionTimeLimitMs: 1_000, revealMs: 50 },
    })
    expect(created.status).toBe(201)
    const dana = await connect(server.wsUrl)
    dana.send({ type: 'join', quizId: 'RANKED', name: 'x', token })
    const q = await dana.next('question')
    dana.send({ type: 'answer', questionId: q.question.id, choice: 1 })
    await dana.next('quiz_end', () => true, 15_000)
    dana.close()
    const ranking = () =>
      fetch(`${server.url}/api/ranking`, { headers: { authorization: `Bearer ${token}` } }).then(
        (r) => r.json() as Promise<{ me: { rank: number; games: number; wins: number } | null }>,
      )
    await waitFor(async () => (await ranking()).me !== null)
    expect((await ranking()).me).toMatchObject({ rank: 1, games: 1, wins: 1 })
    expect((await ranking()).me).toMatchObject({ userId: user.id })
  }, 20_000)

  it('reports readiness with the database in the loop', async () => {
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200)
  })
})

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
