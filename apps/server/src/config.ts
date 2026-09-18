/**
 * Runtime configuration, read once from the environment. Every knob has a safe default so
 * `pnpm dev` works with no setup; production deployments override via env.
 */
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 0 = pick a free port (tests). */
  PORT: z.coerce.number().int().nonnegative().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /** Joining an unknown quiz id creates a session on the fly (handy for demos; off in prod). */
  AUTO_CREATE_SESSIONS: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Session id created at boot so the demo has a well-known code. Empty to disable. */
  DEMO_QUIZ_ID: z.string().default('DEMO'),

  /** Minimum interval between leaderboard broadcasts per session. */
  LEADERBOARD_INTERVAL_MS: z.coerce.number().int().positive().default(100),
  /** Number of entries in the broadcast leaderboard. */
  LEADERBOARD_TOP_N: z.coerce.number().int().positive().default(10),
  /** Skip droppable messages to a socket whose send buffer exceeds this many bytes. */
  WS_BACKPRESSURE_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** Server → client ping interval; a socket that misses one is terminated. */
  WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),
  /** Per-connection inbound message budget (token bucket). */
  WS_RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(20),
  WS_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(40),
  /** Finished/empty sessions are disposed after this idle period. */
  SESSION_IDLE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60_000),
  /** Default gameplay timings (overridable per session via POST /api/sessions). */
  LOBBY_MS: z.coerce.number().int().positive().default(8_000),
  QUESTION_TIME_LIMIT_MS: z.coerce.number().int().positive().default(15_000),
  REVEAL_MS: z.coerce.number().int().positive().default(4_000),

  /** Optional Redis URL. When set, sessions are shared across server instances. */
  REDIS_URL: z.string().optional(),
  /** Stable identity of this instance (defaults to a random id). */
  INSTANCE_ID: z.string().optional(),
  /** Session ownership lease; renewed every third of this. */
  SESSION_LEASE_MS: z.coerce.number().int().min(1_000).default(15_000),

  /** Signs login tokens. Unset = random per boot: tokens die with the process and differ per instance. */
  AUTH_SECRET: z.string().min(16).optional(),
  /** Optional Postgres URL. When set: quiz bank is read from the DB, sessions and results are archived. */
  DATABASE_URL: z.string().optional(),
  /** Apply pending migrations at boot (handy in dev; run `pnpm db:migrate` explicitly in prod). */
  DB_AUTO_MIGRATE: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Seed data/quizzes.json into an empty quiz bank at boot. */
  DB_AUTO_SEED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
})

export type Config = z.infer<typeof Env>

/** Load apps/server/.env into process.env if it exists (never overrides variables already set). */
export function loadDotEnv(file = new URL('../.env', import.meta.url)): void {
  try {
    process.loadEnvFile(file)
  } catch {
    // no .env — fine
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${parsed.error.message}`)
  }
  return parsed.data
}
