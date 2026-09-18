/**
 * Session directory — which instance owns which session, and enough metadata for any instance
 * to recreate a session whose owner went away.
 *
 * Ownership is a lease: `SET quiz:{id}:owner <instance> NX PX <ttl>`, renewed by the owner. If
 * the owner dies the lease expires and the next join re-creates the session elsewhere (with
 * fresh state — see docs/DESIGN.md → "Reliability" for the snapshot/replay extension).
 */

import type { SessionOverrides } from '@quiz/protocol'
import type { Redis } from 'ioredis'

export interface SessionMeta {
  definitionId: string
  overrides?: SessionOverrides | undefined
}

const ownerKey = (quizId: string) => `quiz:${quizId}:owner`
const metaKey = (quizId: string) => `quiz:${quizId}:meta`

// Claim if unowned, or re-claim if we already hold it (a restart on the same instance).
const CLAIM_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur == false or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`
// Renew only if we still hold the lease (compare-and-set).
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

export class SessionDirectory {
  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string,
    private readonly leaseMs: number,
  ) {}

  /** True if this instance now owns the session (or already did). */
  async claim(quizId: string): Promise<boolean> {
    const res = await this.redis.eval(CLAIM_LUA, 1, ownerKey(quizId), this.instanceId, this.leaseMs)
    return res === 1
  }

  async renew(quizId: string): Promise<boolean> {
    const res = await this.redis.eval(RENEW_LUA, 1, ownerKey(quizId), this.instanceId, this.leaseMs)
    return res === 1
  }

  async release(quizId: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, ownerKey(quizId), this.instanceId)
  }

  async owner(quizId: string): Promise<string | null> {
    return this.redis.get(ownerKey(quizId))
  }

  async putMeta(quizId: string, meta: SessionMeta): Promise<void> {
    await this.redis.set(metaKey(quizId), JSON.stringify(meta), 'EX', 24 * 3600)
  }

  async getMeta(quizId: string): Promise<SessionMeta | null> {
    const raw = await this.redis.get(metaKey(quizId))
    return raw ? (JSON.parse(raw) as SessionMeta) : null
  }
}
