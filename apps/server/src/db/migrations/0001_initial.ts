/**
 * 0001 — quiz bank, sessions and final standings.
 *
 * Run with `pnpm db:migrate` (or automatically at boot when DB_AUTO_MIGRATE=true).
 */
import { type Kysely, sql } from 'kysely'

// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was, not as it is
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('quizzes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('questions')
    .addColumn('quiz_id', 'text', (c) => c.notNull().references('quizzes.id').onDelete('cascade'))
    .addColumn('id', 'text', (c) => c.notNull())
    .addColumn('position', 'integer', (c) => c.notNull())
    .addColumn('text', 'text', (c) => c.notNull())
    .addColumn('options', 'jsonb', (c) => c.notNull())
    .addColumn('correct_choice', 'integer', (c) => c.notNull())
    .addColumn('time_limit_ms', 'integer')
    .addColumn('points', 'integer')
    .addPrimaryKeyConstraint('questions_pk', ['quiz_id', 'id'])
    .addUniqueConstraint('questions_quiz_position_uq', ['quiz_id', 'position'])
    .addCheckConstraint('questions_correct_choice_ck', sql`correct_choice >= 0`)
    .execute()

  await db.schema
    .createTable('sessions')
    .addColumn('code', 'text', (c) => c.primaryKey())
    .addColumn('quiz_id', 'text', (c) => c.notNull().references('quizzes.id'))
    .addColumn('rules', 'jsonb', (c) => c.notNull())
    .addColumn('instance_id', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('created'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    .addCheckConstraint('sessions_status_ck', sql`status in ('created', 'finished')`)
    .execute()

  await db.schema
    .createIndex('sessions_finished_at_idx')
    .on('sessions')
    .column('finished_at')
    .execute()

  await db.schema
    .createTable('session_results')
    .addColumn('session_code', 'text', (c) =>
      c.notNull().references('sessions.code').onDelete('cascade'),
    )
    .addColumn('user_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('rank', 'integer', (c) => c.notNull())
    .addColumn('score', 'integer', (c) => c.notNull())
    .addColumn('streak', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('answers', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addPrimaryKeyConstraint('session_results_pk', ['session_code', 'user_id'])
    .execute()
}

// biome-ignore lint/suspicious/noExplicitAny: see above
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('session_results').execute()
  await db.schema.dropTable('sessions').execute()
  await db.schema.dropTable('questions').execute()
  await db.schema.dropTable('quizzes').execute()
}
