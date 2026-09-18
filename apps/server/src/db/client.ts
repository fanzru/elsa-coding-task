import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

export type Db = Kysely<Database>

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 5 })
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}
