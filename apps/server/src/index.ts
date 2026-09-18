import { fileURLToPath } from 'node:url'
import { loadConfig, loadDotEnv } from './config.js'
import { createServer } from './server.js'
import { loadQuizBank } from './store/quiz-bank.js'

loadDotEnv()
const config = loadConfig()
const definitions = loadQuizBank(fileURLToPath(new URL('../data/quizzes.json', import.meta.url)))
const server = await createServer({
  config,
  definitions,
  dataDir: fileURLToPath(new URL('../.data', import.meta.url)),
})

server.logger.info(
  {
    url: server.url,
    ws: server.wsUrl,
    quizzes: definitions.map((d) => d.id),
    demo: config.DEMO_QUIZ_ID || null,
  },
  'quiz server listening',
)

// Graceful shutdown: stop accepting, close sockets with a clear code, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.logger.info({ signal }, 'shutting down')
    server
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        server.logger.error({ err }, 'shutdown failed')
        process.exit(1)
      })
  })
}
