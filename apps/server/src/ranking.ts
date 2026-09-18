/**
 * Ranked board without a database: totals per account, updated when a session finishes.
 * With DATABASE_URL the same numbers are derived from `session_results` (PostgresRanking).
 */
import type { LeaderboardEntry, RankedPlayer, RankingResponse } from '@quiz/protocol'
import type { RankingStore } from './db/repository.js'
import { JsonFile } from './store/json-file.js'

type Stats = Omit<RankedPlayer, 'rank'>

/** Same order as the SQL in PostgresRanking: total score, then wins, then user id — never a tie. */
const byRank = (a: Stats, b: Stats) =>
  b.totalScore - a.totalScore || b.wins - a.wins || (a.userId < b.userId ? -1 : 1)

export class MemoryRanking implements RankingStore {
  // ponytail: single-instance totals, mirrored to a JSON file when given; DATABASE_URL for a cluster.
  private readonly stats = new Map<string, Stats>()
  private readonly file: JsonFile<Stats[]> | null

  constructor(file?: string) {
    this.file = file ? new JsonFile(file) : null
    for (const s of this.file?.load([]) ?? []) this.stats.set(s.userId, s)
  }

  record(standings: LeaderboardEntry[]): void {
    for (const e of standings) {
      if (!e.userId.startsWith('u_')) continue // anonymous players get a fresh id per session
      const s = this.stats.get(e.userId) ?? {
        userId: e.userId,
        name: e.name,
        totalScore: 0,
        games: 0,
        wins: 0,
        bestScore: 0,
      }
      s.totalScore += e.score
      s.games += 1
      if (e.rank === 1) s.wins += 1
      s.bestScore = Math.max(s.bestScore, e.score)
      this.stats.set(e.userId, s)
    }
    this.file?.save([...this.stats.values()])
  }

  async ranking(limit: number, userId?: string): Promise<RankingResponse> {
    const all = [...this.stats.values()].sort(byRank).map((s, i) => ({ rank: i + 1, ...s }))
    return { players: all.slice(0, limit), me: all.find((p) => p.userId === userId) ?? null }
  }
}
