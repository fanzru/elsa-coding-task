import type { ConnectionStatus } from '@/lib/useQuizSocket'

const LOOK: Record<ConnectionStatus, { dot: string; ring: string | null; label: string }> = {
  open: { dot: 'bg-good', ring: 'bg-good [animation-duration:2.4s]', label: 'Connected' },
  connecting: { dot: 'bg-accent', ring: 'bg-accent', label: 'Connecting' },
  reconnecting: { dot: 'bg-accent', ring: 'bg-accent', label: 'Reconnecting' },
  closed: { dot: 'bg-bad', ring: null, label: 'Offline' },
}

/** Live connection pill: a breathing dot (faster while reconnecting) and the round-trip time. */
export function ConnectionBadge({ status, rtt }: { status: ConnectionStatus; rtt: number | null }) {
  const { dot, ring, label } = LOOK[status]
  return (
    <span
      className="inline-flex h-7 items-center gap-2 rounded-full border border-line bg-canvas pl-2.5 pr-3 text-[12px] text-ink-2 shadow-[var(--shadow-card)] transition-colors duration-300"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2">
        {ring && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${ring}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-300 ${dot}`} />
      </span>
      <span>{label}</span>
      {status === 'open' && rtt !== null && (
        <span className="font-mono text-[11px] tabular-nums text-mist">{rtt} ms</span>
      )}
    </span>
  )
}
