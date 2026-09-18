/** 0003 — quizzes get a topic (the host dialog groups by it). */
import type { Kysely } from 'kysely'

// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was, not as it is
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('quizzes')
    .addColumn('topic', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
}

// biome-ignore lint/suspicious/noExplicitAny: see above
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('quizzes').dropColumn('topic').execute()
}
