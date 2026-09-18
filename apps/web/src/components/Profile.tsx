'use client'

import type { MeResponse, RankedPlayer } from '@quiz/protocol'
import { BarChartIcon, HomeIcon, PersonIcon } from '@radix-ui/react-icons'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { fetchMe, saveSession } from '@/lib/auth'
import { AppShell } from './ui/AppShell'
import { AuthModal } from './ui/AuthModal'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { fetchRanking, RankedModal } from './ui/RankedModal'

type Me = MeResponse['user']

export function Profile() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null | undefined>(undefined) // undefined = loading
  const [rank, setRank] = useState<RankedPlayer | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [rankedOpen, setRankedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const user = await fetchMe()
      setMe(user)
      setRank(user ? (await fetchRanking(1)).me : null)
    } catch (err) {
      setMe(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const signOut = () => {
    saveSession(null)
    setMe(null)
    setRank(null)
  }

  return (
    <AppShell
      sidebar={{
        items: [
          { icon: <HomeIcon />, label: 'Home', href: '/' },
          { icon: <BarChartIcon />, label: 'Ranked', onSelect: () => setRankedOpen(true) },
        ],
        secondary: [{ icon: <PersonIcon />, label: 'Profile', href: '/profile', active: true }],
      }}
      topCenter="Profile"
    >
      <div className="mx-auto my-auto flex w-full max-w-[520px] flex-col gap-3 px-2 pt-10 pb-6 sm:pt-6 sm:pb-20 fade-up">
        {me === undefined && <p className="text-center text-[13px] text-mist">Loading…</p>}

        {me === null && (
          <Card className="flex flex-col items-center p-6 text-center">
            <PersonIcon className="h-6 w-6 text-mist" />
            <h1 className="mt-3 text-[18px] font-semibold tracking-tight">You are not logged in</h1>
            <p className="mt-1 max-w-[320px] text-[13px] text-ink-2">
              Log in to keep a profile, get ranked, and carry your score across devices.
            </p>
            {error && <p className="mt-2 text-sm text-bad">{error}</p>}
            <div className="mt-4 flex gap-2">
              <Button onClick={() => setAuthOpen(true)}>Log in</Button>
              <Button variant="secondary" onClick={() => router.push('/')}>
                Play as a guest
              </Button>
            </div>
          </Card>
        )}

        {me && (
          <>
            <Card className="flex items-center gap-3 p-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-3 text-[18px] font-semibold text-accent-ink">
                {me.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-semibold tracking-tight">
                  {me.name}
                </span>
                <span className="block text-[12px] text-mist">
                  Member since{' '}
                  {new Date(me.createdAt).toLocaleDateString([], {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
              </span>
              <Button variant="ghost" onClick={signOut}>
                Log out
              </Button>
            </Card>

            <Card className="p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[13px] font-medium">My rank</h2>
                <button
                  type="button"
                  onClick={() => setRankedOpen(true)}
                  className="text-[12px] text-accent hover:underline"
                >
                  See the board
                </button>
              </div>
              {rank ? (
                <>
                  <p className="mt-2 text-[34px] font-bold leading-none tracking-[-0.02em]">
                    #{rank.rank}
                  </p>
                  <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                    {(
                      [
                        ['Points', rank.totalScore],
                        ['Games', rank.games],
                        ['Wins', rank.wins],
                        ['Best game', rank.bestScore],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-page border border-line py-2">
                        <dt className="text-[11px] text-mist">{label}</dt>
                        <dd className="mt-0.5 font-mono text-[14px] tabular-nums">
                          {value.toLocaleString()}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="text-[13px] text-ink-2">
                    Not ranked yet. Finish one session and you are on the board.
                  </p>
                  <Button onClick={() => router.push('/')}>Play now</Button>
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <AuthModal open={authOpen} onOpenChange={setAuthOpen} onDone={() => void load()} />
      <RankedModal open={rankedOpen} onOpenChange={setRankedOpen} />
    </AppShell>
  )
}
