/**
 * @quiz/protocol — the single source of truth for everything that crosses the wire.
 *
 * Both the server (apps/server) and the web client (apps/web) import from here, so a
 * change to a message shape is a compile error on both sides instead of a runtime bug.
 *
 * Conventions
 * - Broadcast server → client messages carry a monotonically increasing `seq` per quiz
 *   session; unicast messages (`welcome`, `answer_result`) carry the latest broadcast `seq`.
 *   Clients use it to order messages and to detect gaps (a gap means: reconnect for a snapshot).
 * - All timestamps are server-side epoch milliseconds. Clients never send timestamps
 *   that influence scoring — timing is server-authoritative.
 *
 * AI-assisted (Claude Code): schemas drafted by the AI, input limits added in review.
 * See docs/AI_COLLABORATION.md #2.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Domain shapes shared with clients
// ---------------------------------------------------------------------------

export const QuizPhase = z.enum(['lobby', 'question', 'reveal', 'finished'])
export type QuizPhase = z.infer<typeof QuizPhase>

/** A question as the client sees it — never includes the correct answer. */
export const PublicQuestion = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  text: z.string(),
  options: z.array(z.string()).min(2).max(6),
  timeLimitMs: z.number().int().positive(),
  /** Server time the question was opened. */
  startedAt: z.number(),
  /** Server time answers stop being accepted (before grace). */
  endsAt: z.number(),
})
export type PublicQuestion = z.infer<typeof PublicQuestion>

export const LeaderboardEntry = z.object({
  rank: z.number().int().positive(),
  userId: z.string(),
  name: z.string(),
  score: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(),
})
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>

export const Leaderboard = z.object({
  /** Top-N entries, already ranked. */
  top: z.array(LeaderboardEntry),
  /** Total participants in the session (may exceed `top.length`). */
  participants: z.number().int().nonnegative(),
  /** The receiving user's own standing — present only in per-connection deliveries. */
  you: LeaderboardEntry.optional(),
})
export type Leaderboard = z.infer<typeof Leaderboard>

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const QuizIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'quiz id may only contain letters, digits, _ and -')

export const DisplayName = z.string().trim().min(1).max(24)

export const JoinMessage = z.object({
  type: z.literal('join'),
  quizId: QuizIdSchema,
  name: DisplayName,
  /** Returning user (reconnect / refresh). Server-issued; opaque to the client. */
  userId: z.string().min(1).max(64).optional(),
  /**
   * Bearer token from `POST /api/auth/login|register`. When present the server takes the
   * player's id and name from it and ignores `name` / `userId`.
   */
  token: z.string().min(1).max(2048).optional(),
  /**
   * Last `seq` the client processed before reconnecting. The server always replies with a full
   * snapshot (`welcome`), so this is not needed for correctness — it lets the server log and
   * measure how far behind reconnecting clients were.
   */
  lastSeq: z.number().int().nonnegative().optional(),
})

export const AnswerMessage = z.object({
  type: z.literal('answer'),
  questionId: z.string().min(1),
  /** Index into `PublicQuestion.options`. */
  choice: z.number().int().min(0).max(5),
})

export const PingMessage = z.object({ type: z.literal('ping') })

export const ClientMessage = z.discriminatedUnion('type', [JoinMessage, AnswerMessage, PingMessage])
export type ClientMessage = z.infer<typeof ClientMessage>
export type JoinMessage = z.infer<typeof JoinMessage>
export type AnswerMessage = z.infer<typeof AnswerMessage>

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

const withSeq = { seq: z.number().int().nonnegative() }

/** First message after a successful join: a full snapshot so the client never has a gap. */
export const WelcomeMessage = z.object({
  type: z.literal('welcome'),
  ...withSeq,
  you: z.object({ userId: z.string(), name: z.string() }),
  quiz: z.object({ id: z.string(), title: z.string(), totalQuestions: z.number().int() }),
  phase: QuizPhase,
  /** Present when phase is `question` or `reveal`. */
  question: PublicQuestion.optional(),
  /** Present when phase is `reveal` or `finished`. */
  correctChoice: z.number().int().optional(),
  /** Present when phase is `lobby`: server time the quiz will auto-start. */
  startsAt: z.number().optional(),
  leaderboard: Leaderboard,
  serverTime: z.number(),
})

export const QuestionMessage = z.object({
  type: z.literal('question'),
  ...withSeq,
  question: PublicQuestion,
  serverTime: z.number(),
})

/** Sent only to the user who answered. */
export const AnswerResultMessage = z.object({
  type: z.literal('answer_result'),
  ...withSeq,
  questionId: z.string(),
  accepted: z.boolean(),
  /** Why the answer was not scored (only when `accepted` is false). */
  reason: z.enum(['already_answered', 'too_late', 'not_open', 'unknown_question']).optional(),
  correct: z.boolean().optional(),
  points: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  /** Caller's running total after this answer. */
  score: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(),
})

export const LeaderboardMessage = z.object({
  type: z.literal('leaderboard'),
  ...withSeq,
  leaderboard: Leaderboard,
})

export const QuestionEndMessage = z.object({
  type: z.literal('question_end'),
  ...withSeq,
  questionId: z.string(),
  correctChoice: z.number().int(),
  answered: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  /** Server time the next question (or finish) is scheduled. */
  nextAt: z.number(),
})

export const QuizEndMessage = z.object({
  type: z.literal('quiz_end'),
  ...withSeq,
  leaderboard: Leaderboard,
})

/**
 * Lobby countdown started. Note there is deliberately no per-player "X joined" broadcast: with
 * N players that is O(N²) messages during the join storm; the participant count travels in the
 * coalesced `leaderboard` message instead.
 */
export const LobbyMessage = z.object({
  type: z.literal('lobby'),
  ...withSeq,
  startsAt: z.number(),
  participants: z.number().int().nonnegative(),
})

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.enum([
    'bad_message',
    'not_joined',
    'quiz_not_found',
    'rate_limited',
    'unauthorized',
    'internal',
  ]),
  message: z.string(),
})

export const PongMessage = z.object({ type: z.literal('pong'), serverTime: z.number() })

export const ServerMessage = z.discriminatedUnion('type', [
  WelcomeMessage,
  QuestionMessage,
  AnswerResultMessage,
  LeaderboardMessage,
  QuestionEndMessage,
  QuizEndMessage,
  LobbyMessage,
  ErrorMessage,
  PongMessage,
])
export type ServerMessage = z.infer<typeof ServerMessage>
export type WelcomeMessage = z.infer<typeof WelcomeMessage>
export type QuestionMessage = z.infer<typeof QuestionMessage>
export type AnswerResultMessage = z.infer<typeof AnswerResultMessage>
export type LeaderboardMessage = z.infer<typeof LeaderboardMessage>
export type QuestionEndMessage = z.infer<typeof QuestionEndMessage>
export type QuizEndMessage = z.infer<typeof QuizEndMessage>
export type LobbyMessage = z.infer<typeof LobbyMessage>
export type ErrorMessage = z.infer<typeof ErrorMessage>

/** Messages that carry a `seq` and are therefore part of the replayable session log. */
export type SequencedServerMessage = Exclude<
  ServerMessage,
  ErrorMessage | z.infer<typeof PongMessage>
>

// ---------------------------------------------------------------------------
// REST shapes (small; the interesting part is the WebSocket protocol above)
// ---------------------------------------------------------------------------

export const QuizSummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  totalQuestions: z.number().int(),
})
export type QuizSummary = z.infer<typeof QuizSummary>

export const SessionOverrides = z.object({
  lobbyMs: z.number().int().min(0).max(300_000).optional(),
  questionTimeLimitMs: z.number().int().min(1_000).max(300_000).optional(),
  revealMs: z.number().int().min(0).max(60_000).optional(),
  endEarlyWhenAllAnswered: z.boolean().optional(),
})
export type SessionOverrides = z.infer<typeof SessionOverrides>

export const CreateSessionRequest = z.object({
  /** Which quiz definition to run. Defaults to the first one in the bank. */
  quizDefinitionId: z.string().optional(),
  /** Optional custom session id (e.g. "DEMO"); auto-generated when omitted. */
  quizId: QuizIdSchema.optional(),
  /** Gameplay timing overrides — used by tests and the load generator. */
  overrides: SessionOverrides.optional(),
})
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>

export const SessionInfo = z.object({
  quizId: z.string(),
  title: z.string(),
  totalQuestions: z.number().int(),
  phase: QuizPhase,
  participants: z.number().int(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

// ---------------------------------------------------------------------------
// Accounts (optional — a display name is enough to play)
// ---------------------------------------------------------------------------

/** Doubles as the player's display name, hence the same 24-char ceiling as `DisplayName`. */
export const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]{3,24}$/, 'username: 3–24 letters, digits or _')
export const AuthRequest = z.object({
  username: Username,
  password: z.string().min(8, 'password: at least 8 characters').max(128),
})
export type AuthRequest = z.infer<typeof AuthRequest>

export const AuthUser = z.object({ id: z.string(), name: z.string() })
export type AuthUser = z.infer<typeof AuthUser>
export const AuthResponse = z.object({ token: z.string(), user: AuthUser })
export type AuthResponse = z.infer<typeof AuthResponse>

/** One row of the ranked board: an account's totals across every finished session. */
export const RankedPlayer = z.object({
  rank: z.number().int().positive(),
  userId: z.string(),
  name: z.string(),
  totalScore: z.number().int().nonnegative(),
  games: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  bestScore: z.number().int().nonnegative(),
})
export type RankedPlayer = z.infer<typeof RankedPlayer>

/** GET /api/ranking — accounts only (anonymous players get a fresh id per session). */
export const RankingResponse = z.object({
  players: z.array(RankedPlayer),
  /** The caller, when a bearer token was sent and the account has finished a session. */
  me: RankedPlayer.nullable(),
})
export type RankingResponse = z.infer<typeof RankingResponse>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse raw text from the socket into a typed client message. Returns `null` on any failure. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const result = ClientMessage.safeParse(json)
  return result.success ? result.data : null
}

/** Same for the client side — lets the web app trust what it renders. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const result = ServerMessage.safeParse(json)
  return result.success ? result.data : null
}
