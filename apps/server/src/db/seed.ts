/**
 * Seed the quiz bank from data/quizzes.json (idempotent). CLI: `pnpm db:seed`.
 * The server also does this at boot when the bank is empty and DB_AUTO_SEED=true.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDotEnv } from '../config.js'
import { loadQuizBank } from '../store/quiz-bank.js'
import { createDb } from './client.js'
import { PostgresQuizStore } from './repository.js'

export const QUIZ_BANK_PATH = fileURLToPath(new URL('../../data/quizzes.json', import.meta.url))

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadDotEnv()
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const db = createDb(url, { max: 1 })
  const defs = loadQuizBank(QUIZ_BANK_PATH)
  await new PostgresQuizStore(db).upsertQuizzes(defs)
  console.log(
    `seeded ${defs.length} quizzes (${defs.reduce((a, d) => a + d.questions.length, 0)} questions)`,
  )
  await db.destroy()
}
