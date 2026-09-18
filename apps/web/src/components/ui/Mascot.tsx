/** A small friendly face on a accent blob — an inline SVG so it stays crisp and needs no assets. */
export function Mascot({ size = 44, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M22 3c5 0 7 3 9.5 3.5S39 9 39 14.5c0 3-1.5 4.5-1.5 7.5S39 27 39 30c0 6-5 8-8 8.5S26 41 22 41s-6-2-9-2.5S5 36 5 30c0-3 1.5-5 1.5-8S5 17.5 5 14.5C5 9 9.5 7 12.5 6.5S17 3 22 3Z"
        fill="var(--color-accent)"
      />
      <circle cx="16.5" cy="20" r="2.2" fill="#ffffff" />
      <circle cx="27.5" cy="20" r="2.2" fill="#ffffff" />
      <circle cx="17.3" cy="19.2" r="0.7" fill="var(--color-accent-ink)" />
      <circle cx="28.3" cy="19.2" r="0.7" fill="var(--color-accent-ink)" />
      <path
        d="M17 27.5c2.5 2.6 7.5 2.6 10 0"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}
