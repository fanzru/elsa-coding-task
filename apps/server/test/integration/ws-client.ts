/** Minimal typed WebSocket client for tests and the load generator. */
import { type ClientMessage, parseServerMessage, type ServerMessage } from '@quiz/protocol'
import WebSocket from 'ws'

export class TestClient {
  readonly ws: WebSocket
  readonly received: ServerMessage[] = []
  /** Everything before this index has been consumed by `next()`. */
  private cursor = 0
  private waiters: Array<{
    pred: (m: ServerMessage) => boolean
    resolve: (m: ServerMessage) => void
  }> = []
  readonly opened: Promise<void>
  readonly closed: Promise<{ code: number; reason: string }>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    this.ws.on('message', (raw) => {
      const msg = parseServerMessage(raw.toString())
      if (!msg)
        throw new Error(`server sent a message that violates the protocol: ${raw.toString()}`)
      this.received.push(msg)
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true
        this.cursor = this.received.length
        w.resolve(msg)
        return false
      })
    })
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg))
  }

  sendRaw(text: string): void {
    this.ws.send(text)
  }

  /**
   * Resolve with the next unconsumed message of `type` matching `extra` — from the backlog if
   * one already arrived, otherwise the next one to arrive. Reads are sequential, like a stream.
   */
  next<T extends ServerMessage['type']>(
    type: T,
    extra: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const pred = (m: ServerMessage): m is Extract<ServerMessage, { type: T }> =>
      m.type === type && extra(m as Extract<ServerMessage, { type: T }>)
    for (let i = this.cursor; i < this.received.length; i++) {
      const m = this.received[i]
      if (m && pred(m)) {
        this.cursor = i + 1
        return Promise.resolve(m)
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m as Extract<ServerMessage, { type: T }>)
        },
      })
    })
  }

  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type)
  }

  close(): void {
    this.ws.close()
  }
}

export async function connect(url: string): Promise<TestClient> {
  const c = new TestClient(url)
  await c.opened
  return c
}
