'use client'

import { useState } from 'react'
import { type AuthSession, authenticate } from '@/lib/auth'
import { Button } from './Button'
import { Modal } from './Modal'

const field =
  'h-9 w-full rounded-lg bg-panel border border-line px-3.5 text-[13px] outline-none placeholder:text-mist focus:bg-canvas focus:border-accent'

export function AuthModal({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: (session: AuthSession) => void
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onDone(await authenticate(mode, username, password))
      setPassword('')
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'login' ? 'Log in' : 'Create an account'}
      description="Your username is your player name, and your score follows you across devices."
    >
      <form onSubmit={submit} className="space-y-3">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={24}
          placeholder="Username"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          className={field}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={128}
          placeholder={mode === 'login' ? 'Password' : 'Password (8+ characters)'}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          className={field}
        />
        {error && <p className="text-sm text-bad">{error}</p>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            className="text-[12px] text-ink-2 hover:text-ink"
            onClick={() => {
              setMode((m) => (m === 'login' ? 'register' : 'login'))
              setError(null)
            }}
          >
            {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}
          </button>
          <Button type="submit" disabled={busy || !username.trim() || password.length < 8}>
            {busy ? '…' : mode === 'login' ? 'Log in' : 'Sign up'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
