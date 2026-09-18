import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage } from '../src/index.js'

describe('parseClientMessage', () => {
  it('accepts a well-formed join', () => {
    const msg = parseClientMessage(JSON.stringify({ type: 'join', quizId: 'DEMO', name: '  Ana ' }))
    expect(msg).toEqual({ type: 'join', quizId: 'DEMO', name: 'Ana' })
  })

  it('rejects unknown types, bad JSON and out-of-range choices', () => {
    expect(parseClientMessage('{"type":"hack"}')).toBeNull()
    expect(parseClientMessage('not json')).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'answer', questionId: 'q1', choice: 9 })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'answer', questionId: 'q1', choice: -1 })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'answer', questionId: 'q1', choice: 1.5 })),
    ).toBeNull()
  })

  it('rejects quiz ids with unsafe characters or excessive length', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'join', quizId: '../x', name: 'a' })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'join', quizId: 'A'.repeat(33), name: 'a' })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'join', quizId: 'ok', name: 'x'.repeat(25) })),
    ).toBeNull()
  })
})

describe('parseServerMessage', () => {
  it('round-trips a leaderboard message', () => {
    const raw = JSON.stringify({
      type: 'leaderboard',
      seq: 3,
      leaderboard: {
        top: [{ rank: 1, userId: 'u', name: 'U', score: 10, streak: 1 }],
        participants: 1,
      },
    })
    expect(parseServerMessage(raw)?.type).toBe('leaderboard')
  })
})
