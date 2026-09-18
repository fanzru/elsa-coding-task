import pino, { type Logger } from 'pino'

export type { Logger }

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: null, // no pid/hostname noise; the deployment platform adds those
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  })
}
