# AI Collaboration Log

**Tool:** Claude Code (Anthropic, Opus model) running in a terminal on my dev machine, with
access to the repository, a shell, a headless browser and the running servers. It was used as a
pair-programmer for the entire challenge: brainstorming, scaffolding, writing code and tests,
running them, load testing, debugging and drafting these documents.

**How to read this file.** Each numbered entry is one place where the AI did meaningful work
(not autocomplete). Code that came out of an entry is marked in the source with a comment of the
form `AI-assisted (Claude Code): … See docs/AI_COLLABORATION.md #N`. For every entry I record
what I asked, what came back, **what was wrong or missing**, and **how it was verified**.

**Honest framing.** Practically every line in this repository was first typed by the AI. My
contribution was direction (what to build, which design to pick, which stack, what the UI
should feel like), review of everything it produced, and insisting on verification: tests at
every layer, a load generator, and clicking through the real UI. The bugs listed below are
real, were found by those verification steps, and are fixed in the code.

---

## #1 — Design brainstorm (before any code)

**Prompt (paraphrased):** *"Read this challenge. Give me ideas first — don't code yet."* Then:
*"Which tech stack would you pick?"* and *"What about Hono + Next.js?"*

**Output:** a structured brainstorm: one-session-one-actor, pure scoring function, coalesced
leaderboard broadcasts, snapshot-then-stream, server-authoritative timing, backpressure rules,
observability metrics that matter, and a suggested repo layout. It also volunteered the main
weakness of its own proposal (a single hot session is still one actor) and an alternative
(Redis ZSET-centric) so I could choose.

**What I changed / decided:** I chose the actor model over ZSET; chose Hono over the AI's first
suggestion (Fastify) and Next.js for the client. The AI pushed back that Next.js cannot host
the WebSocket upgrade, so the server became a separate process in a pnpm monorepo. Both points
are recorded in `DESIGN.md` §7/§9.

**Verification:** design claims were treated as hypotheses to be measured (see #5, #6).

## #2 — Shared protocol (`packages/protocol`)

**Task:** *"Define every WebSocket/REST message as zod schemas shared by server and client."*

**Output:** `ClientMessage` / `ServerMessage` discriminated unions, `parseClientMessage`,
`parseServerMessage`, REST shapes.

**Review notes:** I had it add input hardening I would otherwise have forgotten: `quizId`
regex `[A-Za-z0-9_-]{1,32}`, name length, `choice` bounded 0–5 and integer. Later (see #5) a
message it designed (`player_joined`) was removed for scalability reasons; because the schema
is shared, TypeScript flagged every consumer that had to change.

**Verification:** `packages/protocol/test/protocol.test.ts` — accepts well-formed frames,
rejects bad JSON, unknown types, out-of-range choices, unsafe ids, over-long names. Every
integration test also asserts that *every* frame the server sends parses against
`ServerMessage` (the test client throws otherwise), so the schema is enforced end to end.

## #3 — Pure domain: scoring, leaderboard, property-based invariants

**Task:** *"Implement scoring (time bonus + streak) and ranking as pure functions; then ask
yourself what could silently go wrong in a leaderboard and write property tests for it."*

**Output:** `domain/scoring.ts`, `domain/leaderboard.ts`, and `test/domain/leaderboard.test.ts`
with `fast-check` properties: ranks dense and contiguous, scores non-increasing, permutation
(nobody lost/duplicated, total score preserved), **determinism regardless of input order**, and
that `compareStandings` is a strict total order.

**What was wrong:** the first draft of the determinism property shuffled with
`sort(() => seeded - 0.5)` — a well-known incorrect shuffle that Biome also flagged
(assignment in expression). Replaced with Fisher–Yates driven by a tiny seeded LCG so the
property is meaningful and reproducible.

**Verification:** 24 domain tests pass; the tie-break (`score DESC, scoreSeq ASC, userId ASC`)
has an explicit example test plus the property suite. I also checked the scoring edge cases by
hand: elapsed = limit → 500 pts, inside grace → still 500, `NaN` → worst case, negative → clamped.

## #4 — Session state machine and the actor

**Task:** *"Write the lobby → question → reveal → finished reducer with no I/O (every command
carries `now`), then an actor that applies commands in order, schedules timers from
`nextDeadline()`, and coalesces leaderboard broadcasts."*

**Output:** `domain/session.ts`, `actor/quiz-actor.ts`, tests with fake connections and fake timers.

**Bugs found by the AI-written tests (and fixed):**

1. **Stale leaderboard in the welcome snapshot.** The ranking cache was invalidated in `emit()`,
   but the welcome message is built *between* `dispatch()` and `emit()`, so a late joiner's own
   snapshot did not include them (`leaderboard.you` was `undefined`). The actor test "gives a
   late joiner the current question…" caught it. Fix: invalidate in `dispatch()` when an event
   changes standings (`changesBoard`).
2. **A test with the wrong expectation.** The first coalescing test assumed strictly trailing
   coalescing (nothing sent before the interval). The implementation is leading-edge (first
   change flushes immediately, the rest ride the next flush) — a deliberate latency choice. I
   kept the behaviour and rewrote the test to assert the claim that matters: steady-state
   fan-out ≤ 1 per interval (20 changes over 400 ms → ≤ 6 flushes, final board complete).
3. **Test-harness bug.** My first fake clock advanced ahead of the fake timers, so timers fired
   with `now` already past the *next* deadline and phases were skipped. Switched to vitest's
   fake `Date`, which advances in lockstep with timers — the way production behaves.
4. **Operator precedence typo** in an assertion (`a ?? 0 + b`) — caught because the test failed
   with an obviously wrong number.

**Verification:** 11 actor tests + 10 integration tests over real WebSockets (join by id, many
users, scoring, duplicate refusal with exact reason, reconnect keeps score, rate limit,
malformed frames, restart, metrics content).

## #5 — Smoke test and the join-storm bug (transport + actor)

**Task:** after wiring Hono + `@hono/node-ws`, *"start the server and run three scripted
clients; show me the message flow."*

**Findings from reading the flow (not from tests):**

- A wrong answer with streak 0 still triggered a leaderboard flush although the board was
  unchanged. Added `boardChanged` to the `answer_accepted` event; the actor only schedules a
  flush when score or streak moved. Covered by a new session test and an actor test.
- The 2 000-client load run (see #6) received **2.6 M messages** for 20 k answers. Reading the
  breakdown: ~2 M were `player_joined` broadcasts — O(N²) during the join ramp. Removed the
  message from the protocol (participant count rides the coalesced leaderboard). Re-run:
  0.6 M messages (−77 %), server CPU 46 % → 25 %, join→welcome p99 37 → 7 ms.
- The optimisation that splices the per-recipient `you` into an already-serialised JSON string
  (`spliceYou`) was AI-proposed; I only accepted it with a property test that parses the result
  and validates it against the protocol schema for random names containing quotes/braces
  (`test/actor/splice.test.ts`).

## #6 — Load generator (`scripts/loadtest.ts`)

**Task:** *"Write a load generator: N bots join one session, answer randomly, and measure
join→welcome, answer→ack, and answer→leaderboard-visible latency; diff server metrics
before/after; spread clients across worker threads."*

**Output:** the script as it stands, including the worker-thread fan-out and the metrics diff.

**What was wrong:** bots only answered on `question` messages. Bots that joined after question 1
had opened received it inside `welcome` and never answered it (821 of 20 000 answers missing in
the first 2 000-client run). Fixed by treating a `welcome` in the `question` phase as a
question — which is also the correct client behaviour.

**Verification:** runs at 500 / 2 000 / 5 000 players with 0 connection errors, 0 protocol
errors, all bots finishing; results saved in `docs/loadtest/*.json` and tabulated in
`DESIGN.md` §8.2. The p99 answer→leaderboard latency (≈ 100–140 ms) matches the coalescing
interval + fan-out cost, which is the behaviour the design predicts.

## #7 — Web client hook (`apps/web/src/lib/useQuizSocket.ts`)

**Task:** *"Write a React hook that owns the socket, validates every frame with the shared
schema, reduces messages into UI state, reconnects with backoff and re-joins with the stored
userId."*

**What was wrong — found by clicking, not by tests:** clicking an answer did nothing. Cause:
React StrictMode mounts effects twice in development; the first socket was closed, the second
assigned to `wsRef`, and then the *first* socket's asynchronous `onclose` fired and set
`wsRef.current = null`. `answer()` saw no socket and returned silently. Fix: every handler checks
`wsRef.current !== socket` and ignores itself if stale; the cleanup marks the socket stale
*before* closing it. Verified by driving the real UI in a headless browser (join → answer →
result shown → leaderboard updated) and by checking the server's `quiz_answers_total` counter.

**Also reviewed:** out-of-order guard on `seq`; server clock offset (`serverTime − receivedAt`)
used for the countdown so a client with a skewed clock still sees the right timer; `1001` close
(session disposed) is *not* retried, other closes are.

## #8 — Cluster mode (`apps/server/src/cluster`)

**Task:** *"Make a session reachable from any instance: ownership leases in Redis, gateways
forwarding join/answer through pub/sub, owner batching deliveries back per gateway. Keep the
actor unaware — it should only see `Connection`s."*

**Bugs found by the AI-written cluster tests:**

1. **Lease released too late on shutdown.** `close()` disposed actors (which released leases
   asynchronously) *after* the rest of the shutdown had started; the "re-home after the owner
   disappears" test timed out because the directory still named the dead owner. Fix: release
   leases first, then dispose.
2. **No detection of a crashed owner.** If the owner dies without releasing its lease, a
   gateway forwarded joins into the void for up to 15 s. Added an owner-timeout: a join with no
   reply within 3 s marks the owner dead, the gateway drops its proxy and bounces its sockets
   with `1012` so clients reconnect and are re-homed once the lease lapses. Tested by planting a
   "ghost" owner in Redis with a 1.5 s lease.

**Verification:** 5 cluster tests against a real Redis in Docker; a 1 000-player load run with
every client connected to the *gateway* instance (all traffic through Redis): 0 errors, ack p50
1.3 ms, owner fan-out cost 1.2 ms per flush vs 41 ms when the owner writes 5 000 sockets itself.

## #9 — Documentation and diagrams (see below) · #10 — Postgres archive

**Task (#10):** *"Persist the quiz bank and session results in Postgres with Kysely and a
`0001` migration; the live game must never wait on the database."*

**Output:** `src/db/` (typed schema, `0001_initial`, repositories, migrate/seed CLIs), boot-time
auto-migrate/auto-seed, two archive endpoints, and `test/integration/db.test.ts`.

**What was wrong — found by the AI-written test:** a restarted session reuses its code; the first
draft reset the `sessions` row and deleted the old `session_results` in two separate statements,
so for a moment the row said "created" while the previous standings were still there. The test
observed exactly that window. Fix: one transaction. Also caught: Kysely 0.29 moved `Migrator`
to `kysely/migration` (the AI's import was for an older version — `tsc` flagged it), and the
bank came back in alphabetical order from the DB, changing which quiz was the default — fixed
with an explicit `position` column.

**Verification:** migrations applied twice (second run is a no-op) and rolled back; seed is
idempotent; a full session played over WebSockets ends with the expected rows (rank, score,
streak, answers JSON) and the REST archive agrees; the compiled `dist/` runs migrate → seed →
boot against a real Postgres in Docker.

## #9 — Documentation and diagrams

**Task:** *"Write the design doc from the code: architecture and sequence diagrams (Mermaid),
component table, data flow, technology justification, scalability/performance/reliability/
maintainability/observability, trade-offs. All docs in English."*

**Review:** every number in `DESIGN.md` §8.2 was copied from `docs/loadtest/*.json`, not from
the AI's estimates. I corrected the cross-instance sequence diagram (batching happens on the
owner per gateway, not per socket) and made the "known limitation" (in-memory session state,
re-home restarts from the lobby) explicit rather than letting the doc imply durability.

## #11 — Optional accounts and ranked play (`apps/server/src/auth.ts`, `ranking.ts`, `apps/web/src/components/ui/{AuthModal,RankedModal}.tsx`)

**Task:** *"Add register and login, as thin as possible — the brief does not ask for it."* Then:
*"It is for ranked play: people log in, play, see their rank, and invite friends."* The AI
first checked the brief and DESIGN.md and pointed out auth is a stated non-goal, then built the
smallest version: `scrypt` hashes and HMAC-signed bearer tokens from `node:crypto` (no new
dependency, no session table), a `users` table (`0002_users`) or an in-memory `Map` without a
database, three endpoints, and a `token` field on the WebSocket `join`. For ranked it proposed
deriving the board from `session_results`, which the archive already writes (one SQL
aggregate with `row_number()`), plus an in-memory twin for database-less runs — no new table,
no second write path. The invite was already there (the room link); it only got a button on
the results screen.

**Review notes / what I pushed back on:** the first sketch let a logged-in client just send its
account id as `userId` — but ids are visible on the leaderboard, so anyone could impersonate an
account. Fix: the token is verified on `join` and a bare `u_…` id without a token is refused.
Also added: one identical 401 for "unknown user" and "wrong password", a per-IP token bucket
on `/api/auth/*` (reusing the WebSocket limiter), and case-insensitive uniqueness via an index
on `lower(username)` with the `23505` unique-violation mapped to 409.

**Verification:** `tsc` strict; three integration tests over HTTP + real WebSockets (register →
duplicate 409 → bad input 400 → wrong/unknown 401 → login → `/me`; token pins `you` on join,
bare account id and tampered token get `unauthorized`; two accounts and one anonymous player
finish a session → only the accounts are ranked, in score order, `me` is returned even outside
the requested top and is `null` without a token); the Postgres test registers, logs in, plays a
session and waits for the archive write to surface on `/api/ranking`; then the login and
ranked modals driven by hand in the browser. Known limits are marked `ponytail:` in the code
(in-memory users and totals, per-instance rate-limit buckets, aggregate-on-read ranking).

---

## What worked, what did not

**Where the AI accelerated me most**
- Going from a brainstorm to a typed protocol + pure domain + tests in one sitting; the tests
  it wrote alongside the code are what caught #4.1 immediately.
- Property-based testing: it knew the invariants worth asserting and the `fast-check` API.
- The load generator and the worker-thread plumbing — tedious code I would have put off.
- Explaining its own trade-offs (leading-edge coalescing, why not Socket.IO) in a way I could
  challenge.

**Where it needed me**
- It over-generates: the first design had a per-player join broadcast that only fell over at
  scale (#5). "Looks right" is not "measured right".
- It writes plausible tests with wrong expectations (#4.2) and plausible harnesses with subtle
  bugs (#4.3) — a failing test must be *read*, not just re-run until green.
- Browser realities (StrictMode double effects, #7) were invisible to its unit tests; manual
  end-to-end use found the most user-visible bug of the project.
- Library drift: it initially used `@hono/node-server` v2 with `@hono/node-ws`, which requires
  v1; `ioredis` v6 changed its default export; Biome's config keys had moved. Each was caught by
  `pnpm install` / `tsc`, but I had to read the installed types rather than trust its memory.

**My verification loop, in order of trust**
1. `tsc --noEmit` (strict) and Biome on every change.
2. Unit + property tests for the pure domain (no I/O, fast, deterministic).
3. Actor tests with fake sockets and fake time (ordering, coalescing, backpressure).
4. Integration tests over real WebSockets and a real Redis (protocol enforced on every frame).
5. Load generator with server-metrics diff (the only source for performance claims).
6. Driving the actual UI in a browser (#7) — the step that no automated layer replaced.
