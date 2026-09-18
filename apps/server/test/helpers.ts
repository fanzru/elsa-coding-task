import { DEFAULT_RULES, type QuizDefinition, type SessionRules } from '../src/domain/index.js'
import { createLogger } from '../src/observability/logger.js'
import { createMetrics } from '../src/observability/metrics.js'

export const TEST_DEF: QuizDefinition = {
  id: 'test-quiz',
  title: 'Test Quiz',
  description: 'fixture',
  questions: [
    { id: 'q1', text: 'ubiquitous', options: ['rare', 'everywhere', 'cheap'], correctChoice: 1 },
    { id: 'q2', text: 'ephemeral', options: ['short-lived', 'eternal', 'huge'], correctChoice: 0 },
    { id: 'q3', text: 'candid', options: ['secretive', 'sweet', 'honest'], correctChoice: 2 },
  ],
}

export const FAST_RULES: SessionRules = {
  ...DEFAULT_RULES,
  lobbyMs: 200,
  questionTimeLimitMs: 1_000,
  revealMs: 100,
  endEarlyWhenAllAnswered: false,
}

export const silentLogger = createLogger('silent', false)
export const freshMetrics = () => createMetrics()
