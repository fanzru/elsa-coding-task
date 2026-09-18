/**
 * Domain types for a quiz session. Nothing in `src/domain` performs I/O, reads the clock,
 * or touches sockets — every function is deterministic given its inputs, which is what
 * makes the scoring and leaderboard rules unit- and property-testable.
 */
import type { QuizPhase } from '@quiz/protocol'

export interface QuestionDefinition {
  id: string
  text: string
  options: string[]
  /** Index into `options`. Never sent to clients before the reveal phase. */
  correctChoice: number
  /** Overrides `SessionRules.questionTimeLimitMs` for this question. */
  timeLimitMs?: number
  /** Overrides `ScoringRules.basePoints` for this question. */
  points?: number
}

export interface QuizDefinition {
  id: string
  title: string
  description: string
  questions: QuestionDefinition[]
}

export interface ScoringRules {
  /** Points for a correct answer given instantly. */
  basePoints: number
  /** Fraction of `basePoints` still awarded for a correct answer at the very last moment (0..1). */
  minFraction: number
  /** Extra multiplier per consecutive correct answer *before* this one, e.g. 0.1 = +10 %. */
  streakBonusPerLevel: number
  /** Streak levels stop increasing the bonus beyond this. */
  maxStreakLevel: number
  /** Answers arriving this long after `endsAt` are still accepted (network jitter). */
  graceMs: number
}

export interface SessionRules {
  /** Countdown between the first player joining and question 1 opening. */
  lobbyMs: number
  /** Default time limit per question (question may override). */
  questionTimeLimitMs: number
  /** How long the correct answer + leaderboard are shown between questions. */
  revealMs: number
  /** End a question early once every joined player has answered. */
  endEarlyWhenAllAnswered: boolean
  scoring: ScoringRules
}

export const DEFAULT_SCORING: ScoringRules = {
  basePoints: 1000,
  minFraction: 0.5,
  streakBonusPerLevel: 0.1,
  maxStreakLevel: 5,
  graceMs: 500,
}

export const DEFAULT_RULES: SessionRules = {
  lobbyMs: 8_000,
  questionTimeLimitMs: 15_000,
  revealMs: 4_000,
  endEarlyWhenAllAnswered: true,
  scoring: DEFAULT_SCORING,
}

export interface AnswerRecord {
  choice: number
  correct: boolean
  points: number
  elapsedMs: number
}

export interface Player {
  userId: string
  name: string
  score: number
  streak: number
  /**
   * Monotonic counter (not wall-clock) captured the last time `score` changed, or at join.
   * Used as the tie-breaker: among equal scores, whoever reached it first ranks higher.
   */
  scoreSeq: number
  joinedAt: number
  answers: Map<string, AnswerRecord>
}

export interface SessionState {
  quizId: string
  definition: QuizDefinition
  rules: SessionRules
  phase: QuizPhase
  createdAt: number
  /** Index of the current question when phase is `question` or `reveal`. */
  currentIndex: number
  /** Server time question `currentIndex` opened. */
  questionStartedAt: number
  /** Server time the current question stops (before grace). */
  questionEndsAt: number
  /** Lobby: auto-start time. Reveal: next question time. Otherwise unused. */
  phaseUntil: number | null
  players: Map<string, Player>
  /** Source of `Player.scoreSeq`. */
  nextScoreSeq: number
}
