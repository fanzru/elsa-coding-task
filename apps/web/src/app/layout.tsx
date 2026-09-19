import { GeistMono } from 'geist/font/mono'
import { GeistSans } from 'geist/font/sans'
import type { Metadata } from 'next'
import './globals.css'

const DESCRIPTION = 'Real-time vocabulary quiz: join with a code, answer fast, climb the live leaderboard.'

// Icons and the Open Graph image come from app/icon.tsx and app/opengraph-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: { default: 'Vocab Quiz', template: '%s · Vocab Quiz' },
  description: DESCRIPTION,
  applicationName: 'Vocab Quiz',
  openGraph: { title: 'Vocab Quiz', description: DESCRIPTION, siteName: 'Vocab Quiz', type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Vocab Quiz', description: DESCRIPTION },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
