/** Tiny token bucket — per connection, so one abusive client cannot starve the others. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst
    this.last = now
  }

  /** Returns true if one token was available (and consumed). */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
