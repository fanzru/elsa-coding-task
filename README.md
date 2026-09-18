# Real-Time Vocabulary Quiz

A real-time quiz for an English-learning app: players join a session by code, answer vocabulary
questions, and watch a live leaderboard. Built for the ELSA coding challenge.

**Implemented component:** the real-time server (WebSocket transport, per-session actor,
scoring, coalesced leaderboard fan-out, optional multi-instance mode over Redis, optional
Postgres archive for the quiz bank and results), plus a demo web client and a shared typed
protocol. Auth and analytics are mocked.

| | |
|---|---|
| 📋 The brief | [`docs/elsa_task.md`](docs/elsa_task.md) — the challenge text, with a map from each requirement to where it is answered |
| 📐 System design | [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, data flow, technology choices, scalability/performance/reliability/maintainability/observability, trade-offs |
| 🤖 AI collaboration | [`docs/AI_COLLABORATION.md`](docs/AI_COLLABORATION.md) — what the AI did, what it got wrong, how each piece was verified |
| 📈 Load-test results | [`docs/loadtest/`](docs/loadtest/) — raw JSON from 500 / 2 000 / 5 000-player runs |
| 🎬 Video outline | [`docs/VIDEO_OUTLINE.md`](docs/VIDEO_OUTLINE.md) |

## Quick start

Requirements: Node ≥ 22 and pnpm ≥ 9 (`corepack enable` gives you pnpm). No database needed.

```bash
pnpm install
pnpm dev            # server on http://localhost:4000, web on http://localhost:3000
```

There is also a `Makefile` wrapping every command below — `make help` lists them:

```bash
make install        # pnpm install
make dev            # server + web (WEB_PORT=3100 to change the web port)
make check          # lint + typecheck + tests
make test-redis     # full suite incl. cluster tests (starts/stops a Docker Redis)
make load CLIENTS=2000
make cluster        # docker compose: 2 server instances + Redis + web
```

If port 3000 is busy on your machine, run the two halves separately:
`pnpm dev:server` and `pnpm --filter @quiz/web exec next dev -p 3100`.

Open http://localhost:3000, enter a name, keep the code `DEMO`, and join. **Host a session**
asks for a topic first (Everyday, Academic, Travel, Business, Food, Idioms — from
`apps/server/data/quizzes.json`, or the `quizzes.topic` column with Postgres) and then a quiz
within it. Open the same page in
two more tabs with different names to see the leaderboard move. Or use **Host a new session**
to get a fresh 6-character code and share it.

Useful endpoints on the server:

```
GET  /api/quizzes                       quiz catalogue
POST /api/sessions {quizDefinitionId?, quizId?, overrides?}   create a session (201)
GET  /api/sessions/:id                  phase, participants
GET  /api/sessions/:id/leaderboard      polling fallback
POST /api/sessions/:id/start            skip the lobby countdown
POST /api/sessions/:id/restart          fresh run under the same code
POST /api/auth/register {username, password}   create an account → {token, user} (201)
POST /api/auth/login    {username, password}   → {token, user}
GET  /api/auth/me                       who a `Authorization: Bearer` token belongs to
GET  /api/ranking?limit=50              ranked board: accounts' totals over finished sessions (+ `me` with a bearer)
GET  /healthz  /readyz  /metrics        ops
WS   /ws                                the real-time protocol (docs/DESIGN.md §5)
```

## Accounts and ranked play (optional)

A display name is all it takes to play. **Log in** in the sidebar creates an account instead:
the username becomes the player name, and the socket sends the bearer token on `join`, so the
server pins the identity from the token (a bare account id without a token is refused).

Logged-in players are **ranked**: every finished session adds to their total (points, games,
wins), **Ranked** in the sidebar shows the board and your position, the results screen shows
your overall rank, and **Profile** (`/profile`) shows the account and its "My rank" stats. Anonymous players get a fresh id per session, so they are never
ranked. Invite friends with **Copy invite link** in a room or **Invite friends** on the results
screen — the link lands them straight in the session.

Users and the ranked board live in Postgres when `DATABASE_URL` is set (the board is derived
from `session_results`, no extra table), otherwise in memory. Set `AUTH_SECRET` so tokens
survive a restart and are valid on every instance of a cluster.

## Tests

```bash
pnpm test                 # protocol + domain + actor + integration (real WebSockets), ~8 s
pnpm typecheck
pnpm lint
```

Cluster tests need a Redis and archive tests need a Postgres; both are skipped otherwise:

```bash
make test-full        # starts throwaway Redis + Postgres in Docker, runs everything, stops them
# or by hand:
docker run --rm -d -p 6390:6379 redis:7-alpine
docker run --rm -d -p 5439:5432 -e POSTGRES_USER=quiz -e POSTGRES_PASSWORD=quiz -e POSTGRES_DB=quiz_test postgres:17-alpine
REDIS_URL=redis://127.0.0.1:6390 DATABASE_URL=postgres://quiz:quiz@127.0.0.1:5439/quiz_test pnpm test
```

## Database (Postgres, optional)

Set `DATABASE_URL` (or put it in `apps/server/.env`, see `.env.example`) and the server keeps the
**quiz bank** and a **session archive** (every session, final standings per player, answers) in
Postgres. Live gameplay never touches the database — it stays in the owning actor's memory.

```bash
cp apps/server/.env.example apps/server/.env    # then edit DATABASE_URL
make db-migrate                                 # Kysely migrations: apps/server/src/db/migrations/0001_initial.ts
make db-seed                                    # upsert data/quizzes.json into the bank (idempotent)
pnpm dev:server                                 # DB_AUTO_MIGRATE / DB_AUTO_SEED default to true in dev anyway
curl localhost:4000/api/history                 # recent sessions
curl localhost:4000/api/sessions/DEMO/results   # archived standings for a code
```

Schema: `quizzes`, `questions`, `sessions`, `session_results` (Kysely types in
`apps/server/src/db/schema.ts`). Without `DATABASE_URL` the bank comes from `data/quizzes.json`
and the two archive endpoints answer `501`.

## Load test

With the server running (`pnpm dev:server`, or in production mode
`NODE_ENV=production LOG_LEVEL=warn pnpm dev:server`):

```bash
pnpm test:load -- --clients 2000 --workers 8
# options: --url ws://host:4000/ws --clients N --workers W --connect-rate 1000
#          --question-time 4000 --lobby 8000 --min-answer-delay 200 --max-answer-delay 2500
#          --quiz CODE (join an existing session)  --out DIR (JSON results, default loadtest-results/)
```

The bots join one session, answer every question with a random choice after a random delay,
and report join→welcome, answer→ack and answer→leaderboard-visible latency, plus a diff of the
server's Prometheus metrics. Numbers from this machine are in `docs/DESIGN.md` §8.2.

## Multi-instance mode (Redis)

Any instance can accept any client; the instance that owns a session scores it, others act as
gateways. Try it locally:

```bash
docker run --rm -d -p 6390:6379 redis:7-alpine
REDIS_URL=redis://127.0.0.1:6390 INSTANCE_ID=A PORT=4000 pnpm dev:server
REDIS_URL=redis://127.0.0.1:6390 INSTANCE_ID=B PORT=4001 pnpm dev:server
# web pointed at B while sessions are created on A:
NEXT_PUBLIC_QUIZ_HTTP_URL=http://localhost:4000 NEXT_PUBLIC_QUIZ_WS_URL=ws://localhost:4001/ws pnpm dev:web
```

Or with Docker Compose (two server instances + Redis + the web app):

```bash
docker compose up --build     # web on :3000 → server A (:4000) and B (:4001)
```

## Configuration (server)

All settings are environment variables with safe defaults (`apps/server/src/config.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4000` / `0.0.0.0` | Listen address |
| `AUTO_CREATE_SESSIONS` | `true` | Joining an unknown code creates a session (demo-friendly; set `false` in prod) |
| `DEMO_QUIZ_ID` | `DEMO` | Session created at boot (empty to disable) |
| `LOBBY_MS` / `QUESTION_TIME_LIMIT_MS` / `REVEAL_MS` | `8000` / `15000` / `4000` | Gameplay timings (overridable per session) |
| `LEADERBOARD_INTERVAL_MS` | `100` | Minimum time between leaderboard broadcasts per session |
| `LEADERBOARD_TOP_N` | `10` | Entries in the broadcast leaderboard |
| `WS_BACKPRESSURE_BYTES` | `1000000` | Skip droppable messages to sockets buffering more than this |
| `WS_RATE_LIMIT_PER_SEC` / `WS_RATE_LIMIT_BURST` | `20` / `40` | Per-connection inbound budget |
| `WS_HEARTBEAT_MS` | `30000` | Ping interval; a missed pong terminates the socket |
| `SESSION_IDLE_TTL_MS` | `600000` | Dispose a session with no connections after this |
| `REDIS_URL` | – | Enables multi-instance mode |
| `DATABASE_URL` | – | Postgres for the quiz bank + session archive |
| `DB_AUTO_MIGRATE` / `DB_AUTO_SEED` | `true` / `true` | Migrate at boot / seed an empty bank from `data/quizzes.json` |
| `INSTANCE_ID` / `SESSION_LEASE_MS` | random / `15000` | Cluster identity and ownership lease |
| `LOG_LEVEL` | `info` | pino level |

Web client: `NEXT_PUBLIC_QUIZ_HTTP_URL` (default `http://localhost:4000`) and
`NEXT_PUBLIC_QUIZ_WS_URL` (default `ws://localhost:4000/ws`).

## Repository layout

```
packages/protocol/        zod schemas + types for every message (shared by server and web)
apps/server/
  src/domain/             pure rules: scoring, leaderboard, session state machine
  src/actor/              QuizActor (single writer per session), registry, Connection interface
  src/cluster/            Redis bus, ownership directory, gateway ⇄ owner forwarding
  src/transport/          WebSocket + HTTP (Hono)
  src/observability/      pino logger, Prometheus metrics
  src/db/                 Kysely schema, migrations, repositories, migrate/seed CLIs
  data/quizzes.json       quiz bank source (validated at boot; seeds Postgres)
  scripts/loadtest.ts     load generator
  test/                   unit, property, actor, integration, cluster tests
apps/web/                 Next.js demo client (Radix primitives + Tailwind; join page, quiz room, useQuizSocket hook)
docs/                     design doc, AI log, load-test results, video outline
```

## Deploy

Both apps ship as small images (`apps/server/Dockerfile`, `apps/web/Dockerfile`; multi-stage,
`pnpm deploy --prod` / Next standalone, non-root, with health checks):

```bash
make docker-build                       # quiz-server:local, quiz-web:local
docker run -p 4000:4000 -e REDIS_URL=redis://host:6379 quiz-server:local
docker run -p 3000:3000 quiz-web:local  # bake URLs with --build-arg NEXT_PUBLIC_QUIZ_*_URL
```

**Releases.** `.github/workflows/release.yml` builds and pushes
`ghcr.io/<owner>/<repo>-server` and `-web` (tagged with the version and `latest`) and creates a
GitHub release with generated notes. Trigger it either way:

```bash
make tag VERSION=v0.1.0                 # annotated tag, pushed → workflow runs
# or: GitHub → Actions → Release → Run workflow → version v0.1.0 (creates the tag for you)
```

Set repository variables `QUIZ_HTTP_URL` / `QUIZ_WS_URL` so the web image is built with your
production server URLs. Then run the published images:

```bash
IMAGE_TAG=v0.1.0 docker compose -f compose.release.yaml up
```

Server configuration is entirely environment variables (table above); it needs no volumes.
Put a WebSocket-aware load balancer in front (any L4/L7 LB that forwards `Upgrade` works) and
point every instance at the same `REDIS_URL` for multi-instance mode.

## Production build

```bash
pnpm build                                   # tsc for the server, next build for the web
node apps/server/dist/index.js               # server
pnpm --filter @quiz/web start                # web
```
