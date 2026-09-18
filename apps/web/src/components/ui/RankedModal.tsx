'use client'

import type { RankedPlayer, RankingResponse } from '@quiz/protocol'
import { useEffect, useState } from 'react'
import { loadSession } from '@/lib/auth'
import { HTTP_URL } from '@/lib/config'
import { Modal } from './Modal'

export async function fetchRanking(limit = 50): Promise<RankingResponse> {
  const token = loadSession()?.token
  const res = await fetch(`${HTTP_URL}/api/ranking?limit=${limit}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`The server answered ${res.status}.`)
  return (await res.json()) as RankingResponse
}

export function RankedModal({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<RankingResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetchRanking()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [open])

  const outsideTop = data?.me && data.me.rank > data.players.length
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Ranked"
      description="Total points across finished sessions. Only logged-in players are ranked."
    >
      {error && <p className="text-sm text-bad">{error}</p>}
      {data && data.players.length === 0 && (
        <p className="text-[13px] text-mist">
          No ranked games yet. Log in, finish a session, and you are on the board.
        </p>
      )}
      {data && data.players.length > 0 && (
        <ol className="flex max-h-[50vh] flex-col gap-px overflow-y-auto">
          {data.players.map((p) => (
            <Row key={p.userId} p={p} isYou={p.userId === data.me?.userId} />
          ))}
          {outsideTop && data.me && (
            <>
              <li className="py-0.5 text-center text-[11px] text-mist">···</li>
              <Row p={data.me} isYou />
            </>
          )}
        </ol>
      )}
      {data && !data.me && !loadSession() && (
        <p className="mt-3 text-[11px] text-mist">Log in to be ranked.</p>
      )}
    </Modal>
  )
}

function Row({ p, isYou }: { p: RankedPlayer; isYou: boolean }) {
  return (
    <li
      className={`flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] ${
        isYou ? 'bg-accent-3 text-accent-ink' : ''
      }`}
    >
      <span className="w-5 shrink-0 text-right font-mono text-[11px] text-mist tabular-nums">
        {p.rank}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {p.name}
        {isYou && <span className="ml-1 text-[11px] text-mist">you</span>}
      </span>
      <span className="shrink-0 text-[11px] text-mist">
        {p.games} game{p.games === 1 ? '' : 's'} · {p.wins} win{p.wins === 1 ? '' : 's'}
      </span>
      <span className="shrink-0 font-mono text-[12px] tabular-nums">
        {p.totalScore.toLocaleString()}
      </span>
    </li>
  )
}
