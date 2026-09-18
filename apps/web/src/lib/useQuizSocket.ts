'use client'

/**
 * useQuizSocket — the client half of the protocol.
 *
 * One WebSocket per mounted room. Every inbound frame is validated with the shared zod schema
 * before it touches React state, so a server/client drift shows up as a logged rejection, not
 * a crashed render. Reconnects with exponential backoff and re-joins with the stored userId so
 * a refresh or a flaky mobile connection keeps the player's score.
 *
 * AI-assisted (Claude Code): first draft of the reducer + reconnect loop; reviewed and adjusted
 * by hand (StrictMode double-mount, intentional-close flag, server clock offset).
 * See docs/AI_COLLABORATION.md #7.
 */
import {
  type AnswerResultMessage,
  type Leaderboard,
  type PublicQuestion,
  parseServerMessage,
  type QuizPhase,
  type ServerMessage,
} from '@quiz/protocol'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { loadSession } from './auth'
import { WS_URL } from './config'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface QuizState {
  status: ConnectionStatus
  error: string | null
  you: { userId: string; name: string } | null
  quiz: { id: string; title: string; totalQuestions: number } | null
  phase: QuizPhase | null
  question: PublicQuestion | null
  correctChoice: number | null
  startsAt: number | null
  nextAt: number | null
  leaderboard: Leaderboard
  /** Locally selected choice for the current question (optimistic, before the server result). */
  myChoice: number | null
  lastResult: AnswerResultMessage | null
  questionStats: { answered: number; correctCount: number } | null
  /** serverTime − Date.now(): apply to server timestamps before comparing with the local clock. */
  serverOffset: number
  seq: number
}

const initialState: QuizState = {
  status: 'connecting',
  error: null,
  you: null,
  quiz: null,
  phase: null,
  question: null,
  correctChoice: null,
  startsAt: null,
  nextAt: null,
  leaderboard: { top: [], participants: 0 },
  myChoice: null,
  lastResult: null,
  questionStats: null,
  serverOffset: 0,
  seq: 0,
}

type Action =
  | { type: 'status'; status: ConnectionStatus }
  | { type: 'error'; message: string }
  | { type: 'server'; msg: ServerMessage; receivedAt: number }
  | { type: 'choose'; questionId: string; choice: number }

function reducer(state: QuizState, action: Action): QuizState {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status }
    case 'error':
      return { ...state, error: action.message }
    case 'choose':
      if (state.question?.id !== action.questionId) return state
      return { ...state, myChoice: action.choice }
    case 'server':
      return applyServer(state, action.msg, action.receivedAt)
  }
}

function applyServer(state: QuizState, msg: ServerMessage, receivedAt: number): QuizState {
  // Out-of-order guard: a stale broadcast (lower seq than one already applied) is ignored.
  if ('seq' in msg && msg.type !== 'welcome' && msg.type !== 'answer_result' && msg.seq < state.seq)
    return state

  switch (msg.type) {
    case 'welcome':
      return {
        ...state,
        error: null,
        you: msg.you,
        quiz: msg.quiz,
        phase: msg.phase,
        question: msg.question ?? null,
        correctChoice: msg.correctChoice ?? null,
        startsAt: msg.startsAt ?? null,
        nextAt: null,
        leaderboard: msg.leaderboard,
        myChoice: null,
        lastResult: null,
        questionStats: null,
        serverOffset: msg.serverTime - receivedAt,
        seq: msg.seq,
      }
    case 'lobby':
      return { ...state, phase: 'lobby', startsAt: msg.startsAt, seq: msg.seq }
    case 'question':
      return {
        ...state,
        phase: 'question',
        question: msg.question,
        correctChoice: null,
        myChoice: null,
        lastResult: null,
        questionStats: null,
        nextAt: null,
        serverOffset: msg.serverTime - receivedAt,
        seq: msg.seq,
      }
    case 'answer_result':
      return { ...state, lastResult: msg }
    case 'leaderboard':
      return { ...state, leaderboard: msg.leaderboard, seq: msg.seq }
    case 'question_end':
      return {
        ...state,
        phase: 'reveal',
        correctChoice: msg.correctChoice,
        questionStats: { answered: msg.answered, correctCount: msg.correctCount },
        nextAt: msg.nextAt,
        seq: msg.seq,
      }
    case 'quiz_end':
      return {
        ...state,
        phase: 'finished',
        leaderboard: msg.leaderboard,
        question: null,
        nextAt: null,
        seq: msg.seq,
      }
    case 'error':
      return { ...state, error: `${msg.code}: ${msg.message}` }
    case 'pong':
      return state
  }
}

const storageKey = (quizId: string, name: string) => `quiz:${quizId}:${name.toLowerCase()}:userId`

export function useQuizSocket(quizId: string, name: string) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const wsRef = useRef<WebSocket | null>(null)
  const seqRef = useRef(0)
  seqRef.current = state.seq

  useEffect(() => {
    if (!quizId || !name) return
    let ws: WebSocket | null = null
    let closedIntentionally = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      dispatch({ type: 'status', status: attempts === 0 ? 'connecting' : 'reconnecting' })
      const socket = new WebSocket(WS_URL)
      ws = socket
      wsRef.current = socket
      // Handlers of a superseded socket must not touch shared state. React StrictMode mounts
      // effects twice in development: the first socket's async `onclose` used to fire *after*
      // the second socket was assigned and nulled the ref — every answer was then silently
      // dropped. Found by clicking through the UI, not by tests (docs/AI_COLLABORATION.md #7).
      const stale = () => wsRef.current !== socket

      socket.onopen = () => {
        if (stale()) return
        attempts = 0
        dispatch({ type: 'status', status: 'open' })
        let userId: string | undefined
        try {
          userId = localStorage.getItem(storageKey(quizId, name)) ?? undefined
        } catch {
          /* private mode */
        }
        // Logged in: the token decides who we are; the server ignores name/userId then.
        const token = loadSession()?.token
        socket.send(
          JSON.stringify({
            type: 'join',
            quizId,
            name,
            ...(userId ? { userId, lastSeq: seqRef.current } : {}),
            ...(token ? { token } : {}),
          }),
        )
      }

      socket.onmessage = (evt) => {
        if (stale()) return
        const msg = parseServerMessage(String(evt.data))
        if (!msg) {
          console.warn('dropped message that does not match the protocol', evt.data)
          return
        }
        if (msg.type === 'welcome') {
          try {
            localStorage.setItem(storageKey(quizId, name), msg.you.userId)
          } catch {
            /* ignore */
          }
        }
        dispatch({ type: 'server', msg, receivedAt: Date.now() })
      }

      socket.onclose = (evt) => {
        if (stale()) return
        wsRef.current = null
        if (closedIntentionally) {
          dispatch({ type: 'status', status: 'closed' })
          return
        }
        if (evt.code === 1001) {
          // Server disposed/restarted the session — a reconnect would create a fresh player.
          dispatch({ type: 'status', status: 'closed' })
          dispatch({
            type: 'error',
            message: 'This round was closed. Tap Play again to join the new one.',
          })
          return
        }
        attempts += 1
        const delay =
          Math.min(8_000, 500 * 2 ** Math.min(attempts, 4)) * (0.8 + Math.random() * 0.4)
        dispatch({ type: 'status', status: 'reconnecting' })
        retryTimer = setTimeout(connect, delay)
      }

      socket.onerror = () => {
        // onclose follows; nothing else to do here
      }
    }

    connect()
    return () => {
      closedIntentionally = true
      if (retryTimer) clearTimeout(retryTimer)
      wsRef.current = null // mark the socket stale *before* closing so its onclose is ignored
      ws?.close()
    }
  }, [quizId, name])

  const answer = useCallback(
    (choice: number) => {
      const ws = wsRef.current
      const q = state.question
      if (!ws || ws.readyState !== WebSocket.OPEN || !q || state.phase !== 'question') return
      if (state.myChoice !== null) return // already answered — the server would refuse it anyway
      dispatch({ type: 'choose', questionId: q.id, choice })
      ws.send(JSON.stringify({ type: 'answer', questionId: q.id, choice }))
    },
    [state.question, state.phase, state.myChoice],
  )

  return { state, answer }
}
