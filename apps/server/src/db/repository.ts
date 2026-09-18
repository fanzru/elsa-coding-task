/**
 * Everything the rest of the server needs from Postgres, behind two small interfaces so the
 * actor/transport layers never see SQL and can run without a database at all.
 */
import type { LeaderboardEntry, RankedPlayer, RankingResponse } from '@quiz/protocol'
import { sql } from 'kysely'
import type { QuizDefinition, SessionRules, SessionState } from '../domain/types.js'
import type { Db } from './client.js'

export interface QuizStore {
  listQuizzes(): Promise<QuizDefinition[]>
  /** Insert or update the given definitions (idempotent seed). */
  upsertQuizzes(defs: QuizDefinition[]): Promise<void>
}

export interface SessionArchive {
  sessionCreated(
    code: string,
    quizId: string,
    rules: SessionRules,
    instanceId: string,
  ): Promise<void>
  sessionFinished(state: SessionState, standings: LeaderboardEntry[]): Promise<void>
  results(code: string): Promise<SessionResultsView | null>
  recentSessions(limit: number): Promise<SessionSummary[]>
}

export interface SessionSummary {
  code: string
  quizId: string
  status: string
  createdAt: Date
  finishedAt: Date | null
  participants: number
}

export interface SessionResultsView extends SessionSummary {
  standings: Array<{ rank: number; userId: string; name: string; score: number; streak: number }>
}

export class PostgresQuizStore implements QuizStore {
  constructor(private readonly db: Db) {}

  async listQuizzes(): Promise<QuizDefinition[]> {
    const quizzes = await this.db
      .selectFrom('quizzes')
      .selectAll()
      .orderBy('position')
      .orderBy('id')
      .execute()
    if (quizzes.length === 0) return []
    const questions = await this.db
      .selectFrom('questions')
      .selectAll()
      .where(
        'quiz_id',
        'in',
        quizzes.map((q) => q.id),
      )
      .orderBy('quiz_id')
      .orderBy('position')
      .execute()
    return quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      questions: questions
        .filter((qq) => qq.quiz_id === q.id)
        .map((qq) => ({
          id: qq.id,
          text: qq.text,
          options: qq.options,
          correctChoice: qq.correct_choice,
          ...(qq.time_limit_ms !== null ? { timeLimitMs: qq.time_limit_ms } : {}),
          ...(qq.points !== null ? { points: qq.points } : {}),
        })),
    }))
  }

  async upsertQuizzes(defs: QuizDefinition[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const [position, def] of defs.entries()) {
        await trx
          .insertInto('quizzes')
          .values({ id: def.id, title: def.title, description: def.description, position })
          .onConflict((oc) =>
            oc
              .column('id')
              .doUpdateSet({ title: def.title, description: def.description, position }),
          )
          .execute()
        // Replace the question set wholesale so removed questions do not linger.
        await trx.deleteFrom('questions').where('quiz_id', '=', def.id).execute()
        await trx
          .insertInto('questions')
          .values(
            def.questions.map((q, i) => ({
              quiz_id: def.id,
              id: q.id,
              position: i,
              text: q.text,
              options: JSON.stringify(q.options),
              correct_choice: q.correctChoice,
              time_limit_ms: q.timeLimitMs ?? null,
              points: q.points ?? null,
            })),
          )
          .execute()
      }
    })
  }
}

export class PostgresSessionArchive implements SessionArchive {
  constructor(private readonly db: Db) {}

  async sessionCreated(
    code: string,
    quizId: string,
    rules: SessionRules,
    instanceId: string,
  ): Promise<void> {
    // One transaction: a restarted session reuses its code, so resetting the row and dropping
    // the previous standings must be observed together.
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('sessions')
        .values({
          code,
          quiz_id: quizId,
          rules: JSON.stringify(rules),
          instance_id: instanceId,
          finished_at: null,
        })
        .onConflict((oc) =>
          oc.column('code').doUpdateSet({
            quiz_id: quizId,
            rules: JSON.stringify(rules),
            instance_id: instanceId,
            status: 'created',
            finished_at: null,
            created_at: sql`now()`,
          }),
        )
        .execute()
      await trx.deleteFrom('session_results').where('session_code', '=', code).execute()
    })
  }

  async sessionFinished(state: SessionState, standings: LeaderboardEntry[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('sessions')
        .set({ status: 'finished', finished_at: new Date() })
        .where('code', '=', state.quizId)
        .execute()
      await trx.deleteFrom('session_results').where('session_code', '=', state.quizId).execute()
      if (standings.length === 0) return
      await trx
        .insertInto('session_results')
        .values(
          standings.map((e) => ({
            session_code: state.quizId,
            user_id: e.userId,
            name: e.name,
            rank: e.rank,
            score: e.score,
            streak: e.streak,
            answers: JSON.stringify(Object.fromEntries(state.players.get(e.userId)?.answers ?? [])),
          })),
        )
        .execute()
    })
  }

  async results(code: string): Promise<SessionResultsView | null> {
    const session = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst()
    if (!session) return null
    const rows = await this.db
      .selectFrom('session_results')
      .select(['rank', 'user_id', 'name', 'score', 'streak'])
      .where('session_code', '=', code)
      .orderBy('rank')
      .execute()
    return {
      code: session.code,
      quizId: session.quiz_id,
      status: session.status,
      createdAt: session.created_at,
      finishedAt: session.finished_at,
      participants: rows.length,
      standings: rows.map((r) => ({
        rank: r.rank,
        userId: r.user_id,
        name: r.name,
        score: r.score,
        streak: r.streak,
      })),
    }
  }

  async recentSessions(limit: number): Promise<SessionSummary[]> {
    const rows = await this.db
      .selectFrom('sessions')
      .leftJoin('session_results', 'session_results.session_code', 'sessions.code')
      .select(({ fn }) => [
        'sessions.code',
        'sessions.quiz_id',
        'sessions.status',
        'sessions.created_at',
        'sessions.finished_at',
        fn.count<number>('session_results.user_id').as('participants'),
      ])
      .groupBy([
        'sessions.code',
        'sessions.quiz_id',
        'sessions.status',
        'sessions.created_at',
        'sessions.finished_at',
      ])
      .orderBy('sessions.created_at', 'desc')
      .limit(limit)
      .execute()
    return rows.map((r) => ({
      code: r.code,
      quizId: r.quiz_id,
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      participants: Number(r.participants),
    }))
  }
}

// ---- accounts -----------------------------------------------------------------------------

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  createdAt: Date
}

export interface UserStore {
  /** Case-insensitive lookup. */
  findByUsername(username: string): Promise<UserRecord | null>
  /** False when the username is already taken (case-insensitively). */
  create(user: UserRecord): Promise<boolean>
}

export class PostgresUserStore implements UserStore {
  constructor(private readonly db: Db) {}

  async findByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'username', 'password_hash', 'created_at'])
      .where(sql`lower(username)`, '=', username.toLowerCase())
      .executeTakeFirst()
    return row
      ? {
          id: row.id,
          username: row.username,
          passwordHash: row.password_hash,
          createdAt: row.created_at,
        }
      : null
  }

  async create(user: UserRecord): Promise<boolean> {
    try {
      await this.db
        .insertInto('users')
        .values({
          id: user.id,
          username: user.username,
          password_hash: user.passwordHash,
          created_at: user.createdAt,
        })
        .execute()
      return true
    } catch (err) {
      // 23505 = unique_violation on users_username_lower_uq; anything else is a real failure.
      if ((err as { code?: string }).code === '23505') return false
      throw err
    }
  }
}

// ---- ranked (accounts only) ---------------------------------------------------------------

export interface RankingStore {
  /** Top `limit` accounts by total score over finished sessions, plus `me` even when outside the top. */
  ranking(limit: number, userId?: string): Promise<RankingResponse>
}

interface RankedRow {
  user_id: string
  name: string
  total_score: number
  games: number
  wins: number
  best_score: number
  rank: number
}

/** Derived from `session_results`, which the archive already writes — no second source of truth. */
export class PostgresRanking implements RankingStore {
  constructor(private readonly db: Db) {}

  // ponytail: aggregates session_results on every call; add a player_stats rollup when it passes ~1M rows.
  async ranking(limit: number, userId?: string): Promise<RankingResponse> {
    // Order must match MemoryRanking: total score, then wins, then user id — never a tie.
    const { rows } = await sql<RankedRow>`
      with agg as (
        select user_id, max(name) as name, sum(score)::int as total_score, count(*)::int as games,
               (count(*) filter (where rank = 1))::int as wins, max(score)::int as best_score
        from session_results
        where starts_with(user_id, 'u_')
        group by user_id
      ), ranked as (
        select agg.*, (row_number() over (order by total_score desc, wins desc, user_id))::int as rank
        from agg
      )
      select * from ranked where rank <= ${limit} or user_id = ${userId ?? ''} order by rank
    `.execute(this.db)
    const players: RankedPlayer[] = rows.map((r) => ({
      rank: r.rank,
      userId: r.user_id,
      name: r.name,
      totalScore: r.total_score,
      games: r.games,
      wins: r.wins,
      bestScore: r.best_score,
    }))
    return {
      players: players.filter((p) => p.rank <= limit),
      me: players.find((p) => p.userId === userId) ?? null,
    }
  }
}
