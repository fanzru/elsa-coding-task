/**
 * Load generator: N simulated players join one quiz session, answer every question with a
 * random choice after a random delay, and measure what a real user would feel:
 *
 *   join → welcome            : how long until I'm in
 *   answer → answer_result    : did my tap register?
 *   answer → leaderboard(you) : when did the board show my new score? (bounded by coalescing)
 *
 * Clients are spread over worker threads so the generator itself is not the bottleneck.
 *
 * Usage (server must be running):
 *   pnpm test:load -- --clients 2000 --workers 8 --url ws://localhost:4000/ws
 *
 * AI-assisted (Claude Code): skeleton generated from the description above, then reworked by
 * hand: worker-thread fan-out, ramped connects, e2e leaderboard latency, server-metrics diff.
 * See docs/AI_COLLABORATION.md #6.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { parseServerMessage } from '@quiz/protocol'
import WebSocket from 'ws'

interface Options {
  url: string
  api: string
  clients: number
  workers: number
  connectRate: number
  quizId: string | null
  quizDefinitionId: string | null
  minAnswerDelayMs: number
  maxAnswerDelayMs: number
  questionTimeLimitMs: number
  lobbyMs: number
  out: string | null
}

interface WorkerResult {
  connected: number
  connectErrors: number
  closedEarly: number
  protocolErrors: number
  serverErrors: Record<string, number>
  welcomeLatency: number[]
  answerAckLatency: number[]
  boardVisibleLatency: number[]
  answersSent: number
  answersAccepted: number
  leaderboardMsgs: number
  totalMsgs: number
  finished: number
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : def
  }
  const url = get('url', 'ws://localhost:4000/ws')
  return {
    url,
    api: get('api', url.replace(/^ws/, 'http').replace(/\/ws$/, '')),
    clients: Number(get('clients', '1000')),
    workers: Number(get('workers', String(Math.max(1, Math.min(8, availableParallelism() - 2))))),
    connectRate: Number(get('connect-rate', '500')),
    quizId: get('quiz', '') || null,
    quizDefinitionId: get('definition', '') || null,
    minAnswerDelayMs: Number(get('min-answer-delay', '200')),
    maxAnswerDelayMs: Number(get('max-answer-delay', '2500')),
    questionTimeLimitMs: Number(get('question-time', '5000')),
    lobbyMs: Number(get('lobby', '6000')),
    out: get('out', 'loadtest-results') || null,
  }
}

// ---------------------------------------------------------------------------------- worker

function runWorker(): void {
  const { url, count, offset, connectRate, quizId, minAnswerDelayMs, maxAnswerDelayMs } =
    workerData as {
      url: string
      count: number
      offset: number
      connectRate: number
      quizId: string
      minAnswerDelayMs: number
      maxAnswerDelayMs: number
    }
  const r: WorkerResult = {
    connected: 0,
    connectErrors: 0,
    closedEarly: 0,
    protocolErrors: 0,
    serverErrors: {},
    welcomeLatency: [],
    answerAckLatency: [],
    boardVisibleLatency: [],
    answersSent: 0,
    answersAccepted: 0,
    leaderboardMsgs: 0,
    totalMsgs: 0,
    finished: 0,
  }
  let open = 0
  let done = false
  const report = () => {
    if (done) return
    done = true
    parentPort?.postMessage(r)
  }
  parentPort?.on('message', (m) => {
    if (m === 'report') report()
  })

  const startClient = (i: number) => {
    const ws = new WebSocket(url, { perMessageDeflate: false })
    const name = `bot-${offset + i}`
    let joinSentAt = 0
    let answerSentAt = 0
    let expectedScore: number | null = null
    let finished = false
    let answerTimer: NodeJS.Timeout | null = null

    const scheduleAnswer = (question: { id: string; options: string[] }) => {
      const delay = minAnswerDelayMs + Math.random() * (maxAnswerDelayMs - minAnswerDelayMs)
      answerTimer = setTimeout(() => {
        answerTimer = null
        if (ws.readyState !== ws.OPEN) return
        answerSentAt = performance.now()
        r.answersSent++
        ws.send(
          JSON.stringify({
            type: 'answer',
            questionId: question.id,
            choice: Math.floor(Math.random() * question.options.length),
          }),
        )
      }, delay)
    }

    ws.on('open', () => {
      open++
      r.connected++
      joinSentAt = performance.now()
      ws.send(JSON.stringify({ type: 'join', quizId, name }))
    })
    ws.on('error', () => {
      r.connectErrors++
    })
    ws.on('close', () => {
      open--
      if (answerTimer) clearTimeout(answerTimer)
      if (!finished) r.closedEarly++
      if (open === 0) report()
    })
    ws.on('message', (raw) => {
      r.totalMsgs++
      const msg = parseServerMessage(raw.toString())
      if (!msg) {
        r.protocolErrors++
        return
      }
      switch (msg.type) {
        case 'welcome':
          r.welcomeLatency.push(performance.now() - joinSentAt)
          // A late joiner receives the open question inside the snapshot — answer it too.
          if (msg.phase === 'question' && msg.question) scheduleAnswer(msg.question)
          break
        case 'question':
          scheduleAnswer(msg.question)
          break
        case 'answer_result':
          if (answerSentAt) r.answerAckLatency.push(performance.now() - answerSentAt)
          if (msg.accepted) {
            r.answersAccepted++
            // only a scoring answer changes the board; wait for it to show up
            expectedScore = (msg.points ?? 0) > 0 ? msg.score : null
          }
          break
        case 'leaderboard':
          r.leaderboardMsgs++
          if (expectedScore !== null && msg.leaderboard.you?.score === expectedScore) {
            r.boardVisibleLatency.push(performance.now() - answerSentAt)
            expectedScore = null
          }
          break
        case 'quiz_end':
          finished = true
          r.finished++
          ws.close()
          break
        case 'error':
          r.serverErrors[msg.code] = (r.serverErrors[msg.code] ?? 0) + 1
          break
        default:
          break
      }
    })
  }

  // Ramp connections at `connectRate`/s so the run measures steady state, not a SYN flood.
  const perTick = Math.max(1, Math.round(connectRate / 20)) // 20 ticks per second
  let started = 0
  const ramp = setInterval(() => {
    for (let k = 0; k < perTick && started < count; k++) startClient(started++)
    if (started >= count) clearInterval(ramp)
  }, 50)
}

// ------------------------------------------------------------------------------------ main

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? Number.NaN
}

function summarize(name: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b)
  const f = (n: number) => (Number.isNaN(n) ? '   -  ' : `${n.toFixed(1).padStart(7)} ms`)
  return `${name.padEnd(28)} n=${String(sorted.length).padStart(6)}  p50=${f(percentile(sorted, 50))}  p95=${f(percentile(sorted, 95))}  p99=${f(percentile(sorted, 99))}  max=${f(sorted[sorted.length - 1] ?? Number.NaN)}`
}

async function scrapeMetrics(api: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const text = await (await fetch(`${api}/metrics`)).text()
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue
      const sp = line.lastIndexOf(' ')
      out.set(line.slice(0, sp), Number(line.slice(sp + 1)))
    }
  } catch {
    // server metrics are a bonus, not a requirement
  }
  return out
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const workers = Math.min(opts.workers, opts.clients)

  let quizId = opts.quizId
  if (!quizId) {
    const res = await fetch(`${opts.api}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(opts.quizDefinitionId ? { quizDefinitionId: opts.quizDefinitionId } : {}),
        overrides: {
          lobbyMs: opts.lobbyMs,
          questionTimeLimitMs: opts.questionTimeLimitMs,
          revealMs: 1_000,
          endEarlyWhenAllAnswered: true,
        },
      }),
    })
    if (!res.ok) throw new Error(`could not create session: ${res.status} ${await res.text()}`)
    const info = (await res.json()) as { quizId: string; totalQuestions: number }
    quizId = info.quizId
    console.log(`created session ${quizId} (${info.totalQuestions} questions)`)
  }

  console.log(
    `spawning ${opts.clients} clients over ${workers} workers → ${opts.url} (ramp ${opts.connectRate}/s, answer delay ${opts.minAnswerDelayMs}–${opts.maxAnswerDelayMs} ms)`,
  )
  const before = await scrapeMetrics(opts.api)
  const t0 = performance.now()

  const results = await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const count = Math.floor(opts.clients / workers) + (w < opts.clients % workers ? 1 : 0)
      const offset = Array.from(
        { length: w },
        (_, k) => Math.floor(opts.clients / workers) + (k < opts.clients % workers ? 1 : 0),
      ).reduce((a, b) => a + b, 0)
      return new Promise<WorkerResult>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          execArgv: ['--import', 'tsx'],
          workerData: {
            url: opts.url,
            count,
            offset,
            connectRate: opts.connectRate / workers,
            quizId,
            minAnswerDelayMs: opts.minAnswerDelayMs,
            maxAnswerDelayMs: opts.maxAnswerDelayMs,
          },
        })
        const hardStop = setTimeout(() => worker.postMessage('report'), 10 * 60_000)
        worker.on('message', (m: WorkerResult) => {
          clearTimeout(hardStop)
          resolve(m)
          void worker.terminate()
        })
        worker.on('error', reject)
      })
    }),
  )

  const wall = (performance.now() - t0) / 1000
  const after = await scrapeMetrics(opts.api)
  const agg: WorkerResult = results.reduce(
    (a, b) => ({
      connected: a.connected + b.connected,
      connectErrors: a.connectErrors + b.connectErrors,
      closedEarly: a.closedEarly + b.closedEarly,
      protocolErrors: a.protocolErrors + b.protocolErrors,
      serverErrors: Object.fromEntries(
        [...new Set([...Object.keys(a.serverErrors), ...Object.keys(b.serverErrors)])].map((k) => [
          k,
          (a.serverErrors[k] ?? 0) + (b.serverErrors[k] ?? 0),
        ]),
      ),
      welcomeLatency: a.welcomeLatency.concat(b.welcomeLatency),
      answerAckLatency: a.answerAckLatency.concat(b.answerAckLatency),
      boardVisibleLatency: a.boardVisibleLatency.concat(b.boardVisibleLatency),
      answersSent: a.answersSent + b.answersSent,
      answersAccepted: a.answersAccepted + b.answersAccepted,
      leaderboardMsgs: a.leaderboardMsgs + b.leaderboardMsgs,
      totalMsgs: a.totalMsgs + b.totalMsgs,
      finished: a.finished + b.finished,
    }),
    {
      connected: 0,
      connectErrors: 0,
      closedEarly: 0,
      protocolErrors: 0,
      serverErrors: {},
      welcomeLatency: [],
      answerAckLatency: [],
      boardVisibleLatency: [],
      answersSent: 0,
      answersAccepted: 0,
      leaderboardMsgs: 0,
      totalMsgs: 0,
      finished: 0,
    },
  )

  const delta = (k: string) => (after.get(k) ?? 0) - (before.get(k) ?? 0)
  const lines = [
    '',
    `=== load test: ${opts.clients} clients, session ${quizId}, ${wall.toFixed(1)} s wall ===`,
    `connected ${agg.connected}/${opts.clients}  errors=${agg.connectErrors}  closedEarly=${agg.closedEarly}  protocolErrors=${agg.protocolErrors}  finished=${agg.finished}`,
    `answers sent=${agg.answersSent} accepted=${agg.answersAccepted}  messages received=${agg.totalMsgs} (leaderboard=${agg.leaderboardMsgs}, ${(agg.totalMsgs / wall).toFixed(0)} msg/s)`,
    `server errors: ${Object.keys(agg.serverErrors).length ? JSON.stringify(agg.serverErrors) : 'none'}`,
    '',
    summarize('join → welcome', agg.welcomeLatency),
    summarize('answer → answer_result', agg.answerAckLatency),
    summarize('answer → leaderboard shows it', agg.boardVisibleLatency),
    '',
    '--- server (Δ from /metrics) ---',
    `answers processed      : ${delta('quiz_answers_total{result="correct"}') + delta('quiz_answers_total{result="wrong"}')}`,
    `leaderboard fan-outs   : ${delta('quiz_leaderboard_flush_seconds_count')}  (avg ${((delta('quiz_leaderboard_flush_seconds_sum') / Math.max(1, delta('quiz_leaderboard_flush_seconds_count'))) * 1000).toFixed(2)} ms each)`,
    `messages sent          : ${delta('quiz_messages_sent_total{type="leaderboard"}')} leaderboard, ${delta('quiz_messages_sent_total{type="question"}')} question, ${delta('quiz_messages_sent_total{type="answer_result"}')} answer_result`,
    `dropped (backpressure) : ${delta('quiz_messages_dropped_total{reason="backpressure"}')}`,
    `answer processing p99  : ≤ ${bucketP99(after, before, 'quiz_answer_processing_seconds')}`,
    `event loop lag p99     : ${((after.get('nodejs_eventloop_lag_p99_seconds') ?? 0) * 1000).toFixed(1)} ms (at end of run)`,
    `server CPU time        : ${delta('process_cpu_seconds_total').toFixed(2)} s over ${wall.toFixed(1)} s wall  (${((100 * delta('process_cpu_seconds_total')) / wall).toFixed(0)} % of one core)`,
    `server RSS             : ${((after.get('process_resident_memory_bytes') ?? 0) / 1024 / 1024).toFixed(0)} MB`,
    '',
  ]
  console.log(lines.join('\n'))

  if (opts.out) {
    mkdirSync(opts.out, { recursive: true })
    const file = `${opts.out}/${new Date().toISOString().replace(/[:.]/g, '-')}-${opts.clients}c.json`
    writeFileSync(
      file,
      JSON.stringify(
        {
          options: opts,
          quizId,
          wallSeconds: wall,
          summary: {
            ...agg,
            welcomeLatency: undefined,
            answerAckLatency: undefined,
            boardVisibleLatency: undefined,
          },
          percentiles: Object.fromEntries(
            (['welcomeLatency', 'answerAckLatency', 'boardVisibleLatency'] as const).map((k) => {
              const s = [...agg[k]].sort((a, b) => a - b)
              return [
                k,
                {
                  n: s.length,
                  p50: percentile(s, 50),
                  p95: percentile(s, 95),
                  p99: percentile(s, 99),
                  max: s.at(-1),
                },
              ]
            }),
          ),
          report: lines,
        },
        null,
        2,
      ),
    )
    console.log(`wrote ${file}`)
  }
  const ok = agg.connectErrors === 0 && agg.protocolErrors === 0 && agg.finished === agg.connected
  process.exit(ok ? 0 : 1)
}

/** Smallest histogram bucket that contains ≥ 99 % of observations made during the run. */
function bucketP99(
  after: Map<string, number>,
  before: Map<string, number>,
  metric: string,
): string {
  const total = (after.get(`${metric}_count`) ?? 0) - (before.get(`${metric}_count`) ?? 0)
  if (total === 0) return '-'
  const buckets = [...after.keys()]
    .filter((k) => k.startsWith(`${metric}_bucket{le="`) && !k.includes('+Inf'))
    .map((k) => ({
      le: Number(k.slice(k.indexOf('"') + 1, k.lastIndexOf('"'))),
      n: (after.get(k) ?? 0) - (before.get(k) ?? 0),
    }))
    .sort((a, b) => a.le - b.le)
  const hit = buckets.find((b) => b.n / total >= 0.99)
  return hit ? `${(hit.le * 1000).toFixed(1)} ms` : '> 250 ms'
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
} else {
  runWorker()
}
