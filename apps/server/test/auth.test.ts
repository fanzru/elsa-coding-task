import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hashPassword, MemoryUserStore, verifyPassword } from '../src/auth.js'
import { MemoryRanking } from '../src/ranking.js'

const dir = mkdtempSync(join(tmpdir(), 'quiz-auth-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('file-backed stores (no database)', () => {
  it('accounts survive a restart', async () => {
    const file = join(dir, 'users.json')
    const first = new MemoryUserStore(file)
    const hash = await hashPassword('correct horse')
    expect(await first.create({ id: 'u_1', username: 'Ana', passwordHash: hash, createdAt: new Date() })).toBe(true)

    const restarted = new MemoryUserStore(file) // same file, fresh process
    const ana = await restarted.findByUsername('ana')
    expect(ana?.id).toBe('u_1')
    expect(ana?.createdAt).toBeInstanceOf(Date)
    expect(await verifyPassword('correct horse', ana?.passwordHash ?? '')).toBe(true)
    expect(await verifyPassword('wrong', ana?.passwordHash ?? '')).toBe(false)
    expect(await restarted.create({ id: 'u_2', username: 'ANA', passwordHash: hash, createdAt: new Date() })).toBe(false)
  })

  it('ranked totals survive a restart', async () => {
    const file = join(dir, 'ranking.json')
    const first = new MemoryRanking(file)
    first.record([
      { rank: 1, userId: 'u_1', name: 'Ana', score: 120, streak: 2 },
      { rank: 2, userId: 'guest', name: 'Bo', score: 50, streak: 0 },
    ])
    const restarted = new MemoryRanking(file)
    expect((await restarted.ranking(10, 'u_1')).me).toMatchObject({ rank: 1, totalScore: 120, wins: 1 })
    expect((await restarted.ranking(10)).players).toHaveLength(1) // guests are never ranked
  })
})
