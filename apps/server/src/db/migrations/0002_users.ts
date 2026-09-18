/** 0002 — accounts for the optional register/login. */
import { type Kysely, sql } from 'kysely'

// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was, not as it is
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('username', 'text', (c) => c.notNull())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()
  await db.schema
    .createIndex('users_username_lower_uq')
    .on('users')
    .expression(sql`lower(username)`)
    .unique()
    .execute()
}

// biome-ignore lint/suspicious/noExplicitAny: see above
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('users').execute()
}
