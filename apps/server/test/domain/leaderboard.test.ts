import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildBoard,
  compareStandings,
  rankStandings,
  type Standing,
} from '../../src/domain/index.js'

const standingArb: fc.Arbitrary<Standing> = fc.record({
  userId: fc.string({ minLength: 1, maxLength: 8 }),
  name: fc.string({ maxLength: 12 }),
  score: fc.nat({ max: 20_000 }),
  streak: fc.nat({ max: 10 }),
  scoreSeq: fc.nat({ max: 100_000 }),
})

/** Distinct userIds — the map in the real session guarantees this. */
const boardArb = fc.uniqueArray(standingArb, { selector: (s) => s.userId, maxLength: 200 })

describe('rankStandings — examples', () => {
  it('orders by score desc, then who reached the score first, then userId', () => {
    const ranked = rankStandings([
      { userId: 'c', name: 'C', score: 500, streak: 0, scoreSeq: 9 },
      { userId: 'a', name: 'A', score: 500, streak: 0, scoreSeq: 3 },
      { userId: 'b', name: 'B', score: 900, streak: 2, scoreSeq: 7 },
      { userId: 'd', name: 'D', score: 500, streak: 0, scoreSeq: 3 },
    ])
    expect(ranked.map((e) => `${e.rank}:${e.userId}`)).toEqual(['1:b', '2:a', '3:d', '4:c'])
  })

  it('returns an empty board for no players', () => {
    expect(rankStandings([])).toEqual([])
    expect(buildBoard([]).byUser.size).toBe(0)
  })
})

// AI-assisted (Claude Code): property-based invariants suggested when asked
// "what could silently go wrong in a leaderboard?" — see docs/AI_COLLABORATION.md #3.
describe('rankStandings — properties', () => {
  it('ranks are dense and contiguous from 1', () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const ranked = rankStandings(board)
        expect(ranked.map((e) => e.rank)).toEqual(ranked.map((_, i) => i + 1))
      }),
    )
  })

  it('scores are non-increasing down the board', () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const ranked = rankStandings(board)
        for (let i = 1; i < ranked.length; i++) {
          const prev = ranked[i - 1]
          const cur = ranked[i]
          if (!prev || !cur) throw new Error('unreachable')
          expect(prev.score).toBeGreaterThanOrEqual(cur.score)
        }
      }),
    )
  })

  it('is a permutation: nobody is lost or duplicated, total score preserved', () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const ranked = rankStandings(board)
        expect(ranked.length).toBe(board.length)
        expect(new Set(ranked.map((e) => e.userId)).size).toBe(board.length)
        const sum = (xs: { score: number }[]) => xs.reduce((a, x) => a + x.score, 0)
        expect(sum(ranked)).toBe(sum(board))
      }),
    )
  })

  it('is deterministic regardless of input order (no flicker between equal scores)', () => {
    fc.assert(
      fc.property(boardArb, fc.nat(), (board, seed) => {
        // Fisher–Yates with a tiny seeded LCG so the shuffle itself is reproducible.
        let state = seed
        const rand = () => {
          state = (state * 9301 + 49297) % 233280
          return state / 233280
        }
        const shuffled = [...board]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1))
          const a = shuffled[i]
          const b = shuffled[j]
          if (a !== undefined && b !== undefined) {
            shuffled[i] = b
            shuffled[j] = a
          }
        }
        expect(rankStandings(shuffled)).toEqual(rankStandings(board))
      }),
    )
  })

  it('compareStandings is a strict total order (antisymmetric + transitive)', () => {
    fc.assert(
      fc.property(standingArb, standingArb, standingArb, (a, b, c) => {
        const sign = (n: number) => Math.sign(n)
        expect(sign(compareStandings(a, b))).toBe(-sign(compareStandings(b, a)))
        if (compareStandings(a, b) <= 0 && compareStandings(b, c) <= 0) {
          expect(compareStandings(a, c)).toBeLessThanOrEqual(0)
        }
      }),
    )
  })

  it('buildBoard.byUser agrees with entries', () => {
    fc.assert(
      fc.property(boardArb, (board) => {
        const { entries, byUser } = buildBoard(board)
        for (const e of entries) expect(byUser.get(e.userId)).toBe(e)
      }),
    )
  })
})
