/**
 * Prometheus metrics. Named after what an on-call engineer would actually page on:
 * answer processing latency, dropped messages, connection/session counts.
 */
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client'

export interface Metrics {
  registry: Registry
  wsConnections: Gauge
  sessionsActive: Gauge
  participants: Gauge
  answersTotal: Counter<'result'>
  answerProcessing: Histogram
  messagesSent: Counter<'type'>
  messagesDropped: Counter<'reason'>
  leaderboardFlush: Histogram
  clientErrors: Counter<'code'>
}

export function createMetrics(): Metrics {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry }) // event-loop lag, heap, GC — free and essential

  return {
    registry,
    wsConnections: new Gauge({
      name: 'quiz_ws_connections',
      help: 'Open WebSocket connections',
      registers: [registry],
    }),
    sessionsActive: new Gauge({
      name: 'quiz_sessions_active',
      help: 'Quiz sessions held in memory by this instance',
      registers: [registry],
    }),
    participants: new Gauge({
      name: 'quiz_participants',
      help: 'Players joined across all sessions on this instance',
      registers: [registry],
    }),
    answersTotal: new Counter({
      name: 'quiz_answers_total',
      help: 'Answers processed, by outcome',
      labelNames: ['result'],
      registers: [registry],
    }),
    answerProcessing: new Histogram({
      name: 'quiz_answer_processing_seconds',
      help: 'Time from receiving an answer frame to sending its result',
      buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers: [registry],
    }),
    messagesSent: new Counter({
      name: 'quiz_messages_sent_total',
      help: 'Server → client messages, by type',
      labelNames: ['type'],
      registers: [registry],
    }),
    messagesDropped: new Counter({
      name: 'quiz_messages_dropped_total',
      help: 'Messages intentionally not sent (backpressure) or lost (socket closed)',
      labelNames: ['reason'],
      registers: [registry],
    }),
    leaderboardFlush: new Histogram({
      name: 'quiz_leaderboard_flush_seconds',
      help: 'Time to rank and fan out one leaderboard update to all connections of a session',
      buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
      registers: [registry],
    }),
    clientErrors: new Counter({
      name: 'quiz_client_errors_total',
      help: 'Error messages sent to clients, by code',
      labelNames: ['code'],
      registers: [registry],
    }),
  }
}
