/**
 * Database schema as Kysely types. Kept in sync with `migrations/` by hand — the migration is
 * the source of truth for Postgres, this file is the source of truth for the compiler.
 *
 * Postgres holds what must outlive a process: the quiz bank, a record of every session and
 * the final standings. The live state of a running session (answers, scores, timers) stays
 * in the owning actor's memory — see docs/DESIGN.md §2.
 */
import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type { AnswerRecord, SessionRules } from '../domain/types.js'

export interface QuizzesTable {
  id: string
  title: string
  topic: string
  description: string
  /** Display order in the catalogue; the first quiz is the default for new sessions. */
  position: number
  created_at: Generated<Date>
}

export interface QuestionsTable {
  quiz_id: string
  id: string
  position: number
  text: string
  options: JSONColumnType<string[]>
  correct_choice: number
  time_limit_ms: number | null
  points: number | null
}

export type SessionStatus = 'created' | 'finished'

export interface SessionsTable {
  code: string
  quiz_id: string
  rules: JSONColumnType<SessionRules>
  instance_id: string
  status: ColumnType<SessionStatus, SessionStatus | undefined, SessionStatus>
  created_at: Generated<Date>
  finished_at: Date | null
}

export interface SessionResultsTable {
  session_code: string
  user_id: string
  name: string
  rank: number
  score: number
  streak: number
  answers: JSONColumnType<Record<string, AnswerRecord>>
}

export interface UsersTable {
  id: string
  /** Case preserved for display; unique case-insensitively (index on lower(username)). */
  username: string
  password_hash: string
  created_at: Generated<Date>
}

export interface Database {
  users: UsersTable
  quizzes: QuizzesTable
  questions: QuestionsTable
  sessions: SessionsTable
  session_results: SessionResultsTable
}
