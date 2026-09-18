import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    // Integration files share one Postgres and reset its schema: run them one at a time.
    fileParallelism: false,
  },
})
