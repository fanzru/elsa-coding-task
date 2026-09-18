/**
 * Optional accounts: register / login / me. Kept deliberately small — scrypt password hashes
 * and HMAC-signed bearer tokens straight from node:crypto, no session table, no new
 * dependency. A token carries the player's id and name, so the WebSocket `join` can pin the
 * identity server-side (`transport/ws.ts`). Users live in Postgres when configured, otherwise
 * in memory.
 *
 * AI-assisted (Claude Code): see docs/AI_COLLABORATION.md #11.
 */
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { getConnInfo } from '@hono/node-server/conninfo'
import { AuthRequest, type AuthResponse, type MeResponse } from '@quiz/protocol'
import { type Context, Hono } from 'hono'
import type { UserRecord, UserStore } from './db/repository.js'
import { JsonFile } from './store/json-file.js'
import { TokenBucket } from './transport/rate-limit.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const TOKEN_TTL_MS = 30 * 24 * 60 * 60_000

export interface AuthClaims {
  /** User id — always `u_…`, so an unauthenticated join can be stopped from claiming one. */
  sub: string
  name: string
  exp: number
}

/** Accounts without a database: a Map, mirrored to a JSON file when one is given so restarts keep them. */
export class MemoryUserStore implements UserStore {
  // ponytail: single-instance only; set DATABASE_URL to share accounts across instances.
  private readonly byName = new Map<string, UserRecord>()
  private readonly file: JsonFile<UserRecord[]> | null

  constructor(file?: string) {
    this.file = file ? new JsonFile(file) : null
    for (const u of this.file?.load([]) ?? [])
      this.byName.set(u.username.toLowerCase(), { ...u, createdAt: new Date(u.createdAt) })
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    return this.byName.get(username.toLowerCase()) ?? null
  }

  async create(user: UserRecord): Promise<boolean> {
    const key = user.username.toLowerCase()
    if (this.byName.has(key)) return false
    this.byName.set(key, user)
    this.file?.save([...this.byName.values()])
    return true
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

/** `base64url(claims).base64url(hmac)` — stateless, so it works on every cluster instance that shares the secret. */
export function createTokens(secret: string, clock: () => number) {
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url')
  return {
    issue(user: Pick<UserRecord, 'id' | 'username'>): string {
      const claims: AuthClaims = { sub: user.id, name: user.username, exp: clock() + TOKEN_TTL_MS }
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
      return `${body}.${sign(body)}`
    },
    verify(token: string): AuthClaims | null {
      const [body, sig] = token.split('.')
      if (!body || !sig) return null
      const expected = sign(body)
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
        return null
      try {
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<AuthClaims>
        if (typeof claims.sub !== 'string' || typeof claims.name !== 'string') return null
        if (typeof claims.exp !== 'number' || claims.exp <= clock()) return null
        return { sub: claims.sub, name: claims.name, exp: claims.exp }
      } catch {
        return null
      }
    },
  }
}

export interface AuthDeps {
  users: UserStore
  secret: string
  clock: () => number
}

export interface Auth {
  /** Mounted at /api/auth. */
  routes: Hono
  verifyToken: (token: string) => AuthClaims | null
}

export function createAuth(deps: AuthDeps): Auth {
  const tokens = createTokens(deps.secret, deps.clock)
  const app = new Hono()

  // Brute-force brake: 20 attempts, then 1/s, per client address.
  // ponytail: buckets are per instance and never evicted; move to Redis before facing the internet.
  const buckets = new Map<string, TokenBucket>()
  app.use('*', async (c, next) => {
    const ip = getConnInfo(c).remote.address ?? 'unknown'
    let bucket = buckets.get(ip)
    if (!bucket) buckets.set(ip, (bucket = new TokenBucket(1, 20, deps.clock())))
    if (!bucket.take(deps.clock())) return c.json({ error: 'too many attempts, slow down' }, 429)
    await next()
  })

  const parseBody = async (c: Context) =>
    AuthRequest.safeParse(await c.req.json().catch(() => ({})))
  const respond = (c: Context, user: UserRecord, status: 200 | 201) =>
    c.json(
      { token: tokens.issue(user), user: { id: user.id, name: user.username } } satisfies AuthResponse,
      status,
    )

  app.post('/register', async (c) => {
    const parsed = await parseBody(c)
    if (!parsed.success)
      return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
    const user: UserRecord = {
      id: `u_${randomUUID()}`,
      username: parsed.data.username,
      passwordHash: await hashPassword(parsed.data.password),
      createdAt: new Date(deps.clock()),
    }
    if (!(await deps.users.create(user))) return c.json({ error: 'that username is taken' }, 409)
    return respond(c, user, 201)
  })

  app.post('/login', async (c) => {
    const parsed = await parseBody(c)
    if (!parsed.success) return c.json({ error: 'wrong username or password' }, 401)
    const user = await deps.users.findByUsername(parsed.data.username)
    // One answer for "no such user" and "wrong password": do not reveal which usernames exist.
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash)))
      return c.json({ error: 'wrong username or password' }, 401)
    return respond(c, user, 200)
  })

  app.get('/me', async (c) => {
    const header = c.req.header('authorization') ?? ''
    const claims = tokens.verify(header.replace(/^Bearer\s+/i, ''))
    // A valid token whose account is gone (in-memory store after a restart) is also a 401,
    // so the client drops the stale session instead of showing a ghost profile.
    const user = claims && (await deps.users.findByUsername(claims.name))
    if (!user || user.id !== claims?.sub) return c.json({ error: 'unauthorized' }, 401)
    return c.json({
      user: { id: user.id, name: user.username, createdAt: user.createdAt.toISOString() },
    } satisfies MeResponse)
  })

  return { routes: app, verifyToken: tokens.verify }
}
