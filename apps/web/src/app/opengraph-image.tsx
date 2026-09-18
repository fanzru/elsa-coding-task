import { ImageResponse } from 'next/og'
import { Mascot } from '@/components/ui/Mascot'

export const alt = 'Vocab Quiz — learn words, live'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/** Link preview for chats and social: the mascot, the name, one line of pitch. */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#faf8f4',
        color: '#1c1917',
      }}
    >
      <Mascot size={180} accent="#1f5cf7" ink="#0b3aa8" />
      <div style={{ marginTop: 32, fontSize: 88, fontWeight: 700, letterSpacing: -3 }}>
        Vocab Quiz
      </div>
      <div style={{ marginTop: 8, fontSize: 34, color: '#6b6560' }}>
        Learn words, live. Join with a code, answer fast, climb the leaderboard.
      </div>
    </div>,
    size,
  )
}
