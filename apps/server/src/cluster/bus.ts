/**
 * Message bus between server instances. Only needed when more than one instance serves the
 * same quiz session; a single instance never touches it.
 */
import { Redis } from 'ioredis'
import type { Logger } from '../observability/logger.js'

export interface Bus {
  publish(channel: string, payload: string): Promise<void>
  /** Returns an unsubscribe function. */
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>
  close(): Promise<void>
}

export class RedisBus implements Bus {
  private readonly pub: Redis
  private readonly sub: Redis
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()

  constructor(url: string, logger: Logger) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    this.sub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    for (const c of [this.pub, this.sub])
      c.on('error', (err: Error) => logger.warn({ err }, 'redis error'))
    this.sub.on('message', (channel: string, payload: string) => {
      const set = this.handlers.get(channel)
      if (!set) return
      for (const h of set) h(payload)
    })
  }

  get client(): Redis {
    return this.pub
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.pub.publish(channel, payload)
  }

  async subscribe(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
      await this.sub.subscribe(channel)
    }
    set.add(handler)
    return async () => {
      const s = this.handlers.get(channel)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) {
        this.handlers.delete(channel)
        await this.sub.unsubscribe(channel)
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.pub.quit(), this.sub.quit()])
  }
}
