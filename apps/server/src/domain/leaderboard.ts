/**
 * Leaderboard ranking — pure and deterministic.
 *
 * Order: score DESC, then scoreSeq ASC (reached that score first), then userId ASC.
 * The third key guarantees a total order, so two renders of the same state never disagree
 * (a leaderboard that "flickers" between equal-score players is a real UX bug).
 *
 * Complexity: O(n log n) per ranking. With coalesced flushes (≤ 10 Hz per session) this is
 * comfortably cheap for thousands of players; see docs/DESIGN.md → "Scalability" for when a
 * sorted-set (Redis ZSET / skip list) would replace it.
 */
import type { LeaderboardEntry } from '@quiz/protocol'

export interface Standing {
  userId: string
  name: string
  score: number
  streak: number
  scoreSeq: number
}

export function compareStandings(a: Standing, b: Standing): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.scoreSeq !== b.scoreSeq) return a.scoreSeq - b.scoreSeq
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
}

/** Rank every standing. Ranks are dense and contiguous (1, 2, 3, …). */
export function rankStandings(standings: Iterable<Standing>): LeaderboardEntry[] {
  const sorted = Array.from(standings).sort(compareStandings)
  return sorted.map((s, i) => ({
    rank: i + 1,
    userId: s.userId,
    name: s.name,
    score: s.score,
    streak: s.streak,
  }))
}

export interface RankedBoard {
  entries: LeaderboardEntry[]
  byUser: Map<string, LeaderboardEntry>
}

/** Rank once, index by user, so per-connection "you" lookups are O(1). */
export function buildBoard(standings: Iterable<Standing>): RankedBoard {
  const entries = rankStandings(standings)
  const byUser = new Map<string, LeaderboardEntry>()
  for (const e of entries) byUser.set(e.userId, e)
  return { entries, byUser }
}
