import { ImageResponse } from 'next/og'
import { Mascot } from '@/components/ui/Mascot'

export const size = { width: 64, height: 64 }
export const contentType = 'image/png'

/** Favicon: the mascot rendered to PNG at build time — every browser, no asset files. */
export default function Icon() {
  return new ImageResponse(<Mascot size={64} accent="#1f5cf7" ink="#0b3aa8" />, size)
}
