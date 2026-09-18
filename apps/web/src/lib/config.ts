/**
 * Where the quiz server lives. Set NEXT_PUBLIC_QUIZ_HTTP_URL / NEXT_PUBLIC_QUIZ_WS_URL to pin
 * it; otherwise assume the server runs on port 4000 of whatever host served this page, which
 * makes `pnpm dev` work from localhost and from another device on the LAN alike.
 */
function defaultHost(): string {
  if (typeof window === 'undefined') return 'localhost'
  return window.location.hostname
}

export const HTTP_URL = process.env.NEXT_PUBLIC_QUIZ_HTTP_URL || `http://${defaultHost()}:4000`
export const WS_URL = process.env.NEXT_PUBLIC_QUIZ_WS_URL || `ws://${defaultHost()}:4000/ws`
