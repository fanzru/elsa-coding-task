/**
 * Optional account: the bearer token and user from POST /api/auth/{login,register}, kept in
 * localStorage. The socket sends the token on `join`; the server pins the identity from it.
 */
import type { MeResponse } from '@quiz/protocol'
import { HTTP_URL } from './config'

export interface AuthSession {
  token: string
  user: { id: string; name: string }
}

const KEY = 'quiz:auth'

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as AuthSession) : null
  } catch {
    return null
  }
}

export function saveSession(session: AuthSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session))
    else localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}

export async function authenticate(
  mode: 'login' | 'register',
  username: string,
  password: string,
): Promise<AuthSession> {
  const res = await fetch(`${HTTP_URL}/api/auth/${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: username.trim(), password }),
  })
  const body = (await res.json().catch(() => ({}))) as Partial<AuthSession> & { error?: string }
  if (!res.ok || !body.token || !body.user)
    throw new Error(body.error ?? `The server answered ${res.status}.`)
  const session = { token: body.token, user: body.user }
  saveSession(session)
  return session
}

/** The account behind the stored token. A 401 means the token is stale: the session is dropped. */
export async function fetchMe(): Promise<MeResponse['user'] | null> {
  const token = loadSession()?.token
  if (!token) return null
  const res = await fetch(`${HTTP_URL}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  if (res.status === 401) {
    saveSession(null)
    return null
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}.`)
  return ((await res.json()) as MeResponse).user
}
