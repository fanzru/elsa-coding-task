import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'icon'

const styles: Record<Variant, string> = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-white text-[13px] font-medium px-3.5 h-8 transition hover:bg-accent-hover disabled:opacity-30 disabled:hover:bg-accent',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-lg bg-canvas border border-line-2 text-ink text-[13px] font-medium px-3.5 h-8 transition hover:bg-panel disabled:opacity-30',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-lg text-[13px] text-ink-2 px-2.5 h-8 transition hover:bg-panel hover:text-ink disabled:opacity-30',
  icon: 'inline-flex items-center justify-center rounded-lg h-7 w-7 text-ink-2 transition hover:bg-panel hover:text-ink disabled:opacity-30',
}

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type={type} className={`${styles[variant]} ${className}`} {...rest} />
}
