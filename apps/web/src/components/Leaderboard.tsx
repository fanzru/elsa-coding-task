'use client'

import type { Leaderboard as LeaderboardData, LeaderboardEntry } from '@quiz/protocol'
import { LightningBoltIcon } from '@radix-ui/react-icons'
import { Avatar, Tooltip } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'

export function Leaderboard({ data, youId }: { data: LeaderboardData; youId: string | null }) {
  // Flash rows whose score changed since the previous render.
  const prev = useRef<Map<string, number>>(new Map())
  const [changed, setChanged] = useState<Set<string>>(new Set())
  useEffect(() => {
    const next = new Set<string>()
    for (const e of data.top) {
      const before = prev.current.get(e.userId)
      if (before !== undefined && before !== e.score) next.add(e.userId)
    }
    prev.current = new Map(data.top.map((e) => [e.userId, e.score]))
    setChanged(next)
    if (next.size) {
      const t = setTimeout(() => setChanged(new Set()), 900)
      return () => clearTimeout(t)
    }
  }, [data])

  const youInTop = data.you && data.top.some((e) => e.userId === data.you?.userId)

  return (
    <Tooltip.Provider delayDuration={200}>
      <section className="card rounded-2xl p-1.5">
        <header className="flex items-baseline justify-between px-2.5 pt-1.5 pb-1.5">
          <h2 className="text-[13px] font-medium">Leaderboard</h2>
          <span className="text-[11px] text-mist">
            {data.participants} player{data.participants === 1 ? '' : 's'}
          </span>
        </header>
        {data.top.length === 0 ? (
          <p className="px-2.5 pb-2.5 text-[13px] text-mist">Waiting for players…</p>
        ) : (
          <ol className="flex flex-col gap-px">
            {data.top.map((e) => (
              <Row
                key={e.userId}
                entry={e}
                isYou={e.userId === youId}
                flash={changed.has(e.userId)}
              />
            ))}
          </ol>
        )}
        {data.you && !youInTop && (
          <>
            <div className="py-0.5 text-center text-[11px] text-mist">···</div>
            <ol>
              <Row entry={data.you} isYou flash={false} />
            </ol>
          </>
        )}
      </section>
    </Tooltip.Provider>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const a = parts[0]?.[0] ?? '?'
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (a + b).toUpperCase()
}

function Row({ entry, isYou, flash }: { entry: LeaderboardEntry; isYou: boolean; flash: boolean }) {
  return (
    <li
      className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] transition ${
        isYou ? 'bg-accent-3' : ''
      } ${flash ? 'rowflash' : ''}`}
    >
      <span className="w-3.5 shrink-0 text-right font-mono text-[11px] text-mist tabular-nums">
        {entry.rank}
      </span>
      <Avatar.Root className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-panel text-[10px] font-medium text-ink-2">
        <Avatar.Fallback>{initials(entry.name)}</Avatar.Fallback>
      </Avatar.Root>
      <span className="min-w-0 flex-1 truncate">
        {entry.name}
        {isYou && <span className="ml-1 text-[11px] text-mist">you</span>}
      </span>
      {entry.streak >= 2 && (
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-3 px-1.5 py-0.5 text-[11px] text-accent-ink">
              <LightningBoltIcon className="h-3 w-3 text-accent" />
              {entry.streak}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              sideOffset={4}
              className="surface rounded-lg px-2 py-1 text-xs text-ink-2"
            >
              {entry.streak} correct in a row
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      )}
      <span className="font-mono text-[12px] tabular-nums">{entry.score.toLocaleString()}</span>
    </li>
  )
}
