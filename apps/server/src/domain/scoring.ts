/**
 * Scoring — a pure function of (question, choice, server-measured elapsed time, streak).
 *
 * Rules (Kahoot-style, documented in docs/DESIGN.md):
 *   points = round(base × timeFactor × streakMultiplier)   when correct
 *   points = 0                                              when wrong
 *   timeFactor       = minFraction + (1 − minFraction) × (1 − clamp(elapsed / timeLimit, 0, 1))
 *   streakMultiplier = 1 + min(streakBefore, maxStreakLevel) × streakBonusPerLevel
 *
 * `elapsedMs` MUST be computed by the server (receive time − question open time). A client-supplied
 * timestamp would let anyone claim a 0 ms answer.
 *
 * AI-assisted (Claude Code): see docs/AI_COLLABORATION.md #3 (edge cases verified by hand + tests).
 */
import type { QuestionDefinition, ScoringRules } from './types.js'

export interface ScoreResult {
  correct: boolean
  points: number
  /** Streak after applying this answer. */
  streakAfter: number
}

export function scoreAnswer(
  question: QuestionDefinition,
  choice: number,
  elapsedMs: number,
  timeLimitMs: number,
  streakBefore: number,
  rules: ScoringRules,
): ScoreResult {
  const correct = choice === question.correctChoice
  if (!correct) return { correct, points: 0, streakAfter: 0 }

  const base = question.points ?? rules.basePoints
  const fraction = clamp(elapsedMs / timeLimitMs, 0, 1)
  const timeFactor = rules.minFraction + (1 - rules.minFraction) * (1 - fraction)
  const streakLevel = Math.min(Math.max(streakBefore, 0), rules.maxStreakLevel)
  const streakMultiplier = 1 + streakLevel * rules.streakBonusPerLevel

  return {
    correct,
    points: Math.round(base * timeFactor * streakMultiplier),
    streakAfter: streakBefore + 1,
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return hi
  return Math.min(hi, Math.max(lo, n))
}
