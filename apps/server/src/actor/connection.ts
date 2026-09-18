/**
 * Transport-agnostic view of a client connection, as seen by a QuizActor.
 *
 * Keeping the actor ignorant of `ws` means (a) tests can drive it with in-memory fakes and
 * (b) a connection that lives on another gateway instance can be represented the same way
 * (its `send` publishes to a bus instead of a socket).
 */
export interface Connection {
  readonly id: string
  /** Set by the actor when the connection joins a session. */
  userId: string | null
  /**
   * Deliver one JSON frame. Returns false if it was not delivered (socket closed, or the
   * message was `droppable` and the socket is under backpressure).
   */
  send(json: string, opts: SendOptions): boolean
  close(code: number, reason: string): void
}

export interface SendOptions {
  /**
   * Droppable messages are idempotent snapshots (leaderboard, player counts): if the socket's
   * send buffer is over the backpressure threshold we skip them — a fresher one will follow.
   * Non-droppable messages (a new question, the quiz ending) are always queued.
   */
  droppable: boolean
}
