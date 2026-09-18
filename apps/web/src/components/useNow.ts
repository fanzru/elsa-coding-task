'use client'

import { useEffect, useState } from 'react'

/** Local clock that re-renders every `intervalMs` — drives countdowns and progress bars. */
export function useNow(intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
