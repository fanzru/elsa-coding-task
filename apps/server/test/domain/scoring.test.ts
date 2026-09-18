import { describe, expect, it } from 'vitest'
import { DEFAULT_SCORING, type QuestionDefinition, scoreAnswer } from '../../src/domain/index.js'

const q: QuestionDefinition = {
  id: 'q1',
  text: 'What does "ubiquitous" mean?',
  options: ['Rare', 'Everywhere', 'Expensive', 'Ancient'],
  correctChoice: 1,
}
const LIMIT = 10_000

describe('scoreAnswer', () => {
  it('awards full base points for an instant correct answer with no streak', () => {
    expect(scoreAnswer(q, 1, 0, LIMIT, 0, DEFAULT_SCORING)).toEqual({
      correct: true,
      points: 1000,
      streakAfter: 1,
    })
  })

  it('awards minFraction of base at the deadline, never less', () => {
    expect(scoreAnswer(q, 1, LIMIT, LIMIT, 0, DEFAULT_SCORING).points).toBe(500)
    // Inside the grace window elapsed > limit — still clamped to the floor, not negative.
    expect(scoreAnswer(q, 1, LIMIT + 400, LIMIT, 0, DEFAULT_SCORING).points).toBe(500)
  })

  it('decays linearly between the two', () => {
    expect(scoreAnswer(q, 1, LIMIT / 2, LIMIT, 0, DEFAULT_SCORING).points).toBe(750)
    expect(scoreAnswer(q, 1, LIMIT / 4, LIMIT, 0, DEFAULT_SCORING).points).toBe(875)
  })

  it('gives 0 points and resets the streak on a wrong answer', () => {
    expect(scoreAnswer(q, 0, 10, LIMIT, 4, DEFAULT_SCORING)).toEqual({
      correct: false,
      points: 0,
      streakAfter: 0,
    })
  })

  it('applies the streak multiplier based on the streak *before* this answer, capped', () => {
    expect(scoreAnswer(q, 1, 0, LIMIT, 1, DEFAULT_SCORING).points).toBe(1100)
    expect(scoreAnswer(q, 1, 0, LIMIT, 5, DEFAULT_SCORING).points).toBe(1500)
    expect(scoreAnswer(q, 1, 0, LIMIT, 50, DEFAULT_SCORING).points).toBe(1500) // capped at maxStreakLevel
  })

  it('respects per-question point overrides', () => {
    expect(scoreAnswer({ ...q, points: 200 }, 1, 0, LIMIT, 0, DEFAULT_SCORING).points).toBe(200)
  })

  it('is defensive against nonsense elapsed values', () => {
    expect(scoreAnswer(q, 1, -50, LIMIT, 0, DEFAULT_SCORING).points).toBe(1000) // clamped to 0
    expect(scoreAnswer(q, 1, Number.NaN, LIMIT, 0, DEFAULT_SCORING).points).toBe(500) // NaN → worst case
  })
})
