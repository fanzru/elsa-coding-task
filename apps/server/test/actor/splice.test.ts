import { LeaderboardMessage, QuizEndMessage } from '@quiz/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { spliceYou } from '../../src/actor/quiz-actor.js'

// AI-assisted (Claude Code): the string-splice optimisation was AI-proposed; this test is the
// guard that makes it safe — any drift in the message shape breaks it loudly.
// See docs/AI_COLLABORATION.md #5.
describe('spliceYou', () => {
  const entryArb = fc.record({
    rank: fc.integer({ min: 1, max: 10_000 }),
    userId: fc.string({ minLength: 1, maxLength: 40 }),
    name: fc.string({ maxLength: 24 }), // includes quotes, unicode, braces
    score: fc.nat(),
    streak: fc.nat({ max: 20 }),
  })

  it('produces JSON that still satisfies the protocol schema, with `you` attached', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), entryArb, fc.nat(), (top, you, seq) => {
        for (const type of ['leaderboard', 'quiz_end'] as const) {
          const base = JSON.stringify({ type, seq, leaderboard: { top, participants: top.length } })
          const parsed = JSON.parse(spliceYou(base, you))
          const schema = type === 'leaderboard' ? LeaderboardMessage : QuizEndMessage
          const result = schema.safeParse(parsed)
          expect(result.success).toBe(true)
          expect(parsed.leaderboard.you).toEqual(you)
          expect(parsed.leaderboard.top).toEqual(top)
        }
      }),
    )
  })
})
