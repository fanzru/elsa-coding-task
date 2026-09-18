/**
 * Migration runner. Library use: `migrateToLatest(db)`. CLI use:
 *   pnpm db:migrate          # up to latest
 *   pnpm db:migrate down     # roll back one
 * Reads DATABASE_URL (and apps/server/.env when present).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileMigrationProvider, type MigrationResultSet, Migrator } from 'kysely/migration'
import type { Db } from './client.js'

const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export function createMigrator(db: Db): Migrator {
  return new Migrator({ db, provider: new FileMigrationProvider({ fs, path, migrationFolder }) })
}

export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  return createMigrator(db).migrateToLatest()
}

function report(set: MigrationResultSet): void {
  for (const r of set.results ?? []) {
    console.log(
      `${r.status === 'Success' ? '✓' : '✗'} ${r.direction.toLowerCase()} ${r.migrationName}`,
    )
  }
  if (set.error) {
    console.error(set.error)
    process.exit(1)
  }
  if (!set.results?.length) console.log('nothing to do')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { createDb } = await import('./client.js')
  const { loadDotEnv } = await import('../config.js')
  loadDotEnv()
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const db = createDb(url, { max: 1 })
  const migrator = createMigrator(db)
  const direction = process.argv[2] ?? 'latest'
  const set = direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest()
  report(set)
  await db.destroy()
}
