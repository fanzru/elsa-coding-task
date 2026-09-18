import type { Connection } from './connection.js'

/**
 * What the transport needs from "a session", whether the actor lives in this process
 * (QuizActor) or on another instance (cluster/RemoteSession).
 */
export interface SessionHandle {
  readonly quizId: string
  join(conn: Connection, name: string, userId: string, lastSeq?: number): void
  answer(conn: Connection, questionId: string, choice: number): void
  detach(conn: Connection): void
}

export interface SessionResolver {
  resolveForJoin(quizId: string): SessionHandle | Promise<SessionHandle>
}
