/**
 * Quiz definitions. In the full system these live in PostgreSQL behind a content-management
 * API; here they are a JSON file (the "mocked" part of the system), validated at boot so a
 * typo in the bank fails fast instead of at question time.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { QuizDefinition } from '../domain/index.js'

const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(6),
  correctChoice: z.number().int().min(0),
  timeLimitMs: z.number().int().positive().optional(),
  points: z.number().int().positive().optional(),
})

const QuizSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    topic: z.string().min(1),
    description: z.string(),
    questions: z.array(QuestionSchema).min(1),
  })
  .superRefine((quiz, ctx) => {
    const ids = new Set<string>()
    quiz.questions.forEach((q, i) => {
      if (q.correctChoice >= q.options.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'correctChoice'],
          message: 'out of range',
        })
      }
      if (ids.has(q.id))
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'id'], message: 'duplicate' })
      ids.add(q.id)
    })
  })

export const QuizBankSchema = z.array(QuizSchema).min(1)

export function parseQuizBank(json: unknown): QuizDefinition[] {
  const result = QuizBankSchema.safeParse(json)
  if (!result.success) throw new Error(`invalid quiz bank: ${result.error.message}`)
  return result.data.map((q) => ({
    ...q,
    questions: q.questions.map((qq) => ({
      id: qq.id,
      text: qq.text,
      options: qq.options,
      correctChoice: qq.correctChoice,
      ...(qq.timeLimitMs !== undefined ? { timeLimitMs: qq.timeLimitMs } : {}),
      ...(qq.points !== undefined ? { points: qq.points } : {}),
    })),
  }))
}

export function loadQuizBank(path: string): QuizDefinition[] {
  return parseQuizBank(JSON.parse(readFileSync(path, 'utf8')))
}
