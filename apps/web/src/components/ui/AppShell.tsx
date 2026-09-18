'use client'

import {
  Cross2Icon,
  DoubleArrowLeftIcon,
  DoubleArrowRightIcon,
  HamburgerMenuIcon,
} from '@radix-ui/react-icons'
import Link from 'next/link'
import { Dialog, Separator, Tooltip } from 'radix-ui'
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { Mascot } from './Mascot'

export interface NavItem {
  icon: React.ReactNode
  label: string
  onSelect?: () => void
  href?: string
  active?: boolean
}

export interface SidebarProps {
  /** Primary group at the top. */
  items: NavItem[]
  /** Secondary group below a separator. */
  secondary?: NavItem[]
  /** Free-form block (session info, etc.) rendered between the groups and the footer. */
  children?: React.ReactNode
  footer?: { title: string; subtitle: string; onSelect?: () => void }
}

const STORAGE_KEY = 'quiz:sidebar'

/**
 * App frame: a compact dock pinned to the bottom-left (it hugs its content and can be
 * minimised to an icon rail), and the main area. On small screens
 * the sidebar becomes a Radix Dialog drawer behind a menu button.
 */
export function AppShell({
  sidebar,
  topCenter,
  topRight,
  children,
}: {
  sidebar: SidebarProps
  topCenter?: React.ReactNode
  topRight?: React.ReactNode
  children: React.ReactNode
}) {
  const [minimized, setMinimized] = useState(false)
  useEffect(() => {
    try {
      setMinimized(localStorage.getItem(STORAGE_KEY) === 'min')
    } catch {
      /* ignore */
    }
  }, [])
  const toggle = () => {
    setMinimized((m) => {
      try {
        localStorage.setItem(STORAGE_KEY, m ? 'open' : 'min')
      } catch {
        /* ignore */
      }
      return !m
    })
  }

  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="min-h-dvh p-2 flex gap-2 items-start">
        {/* Spacer keeps the main column clear of the floating dock. */}
        <div
          aria-hidden="true"
          className={`hidden lg:block shrink-0 transition-[width] duration-150 ${minimized ? 'w-[52px]' : 'w-[212px]'}`}
        />
        <aside
          className={`card hidden lg:flex fixed left-2 bottom-2 z-20 max-h-[calc(100dvh-1rem)] overflow-y-auto flex-col rounded-2xl p-1.5 transition-[width] duration-150 ${
            minimized ? 'w-[52px]' : 'w-[212px]'
          }`}
        >
          <SidebarBody {...sidebar} minimized={minimized} onToggle={toggle} />
        </aside>

        <main className="relative flex-1 min-w-0 flex flex-col min-h-[calc(100dvh-1rem)]">
          <header className="grid grid-cols-[1fr_auto_1fr] items-center px-2 pt-1 pb-1">
            <div className="flex items-center gap-1">
              <div className="lg:hidden">
                <Drawer sidebar={sidebar} />
              </div>
            </div>
            <div className="text-[13px] text-ink-2 text-center truncate px-2">{topCenter}</div>
            <div className="flex items-center justify-end gap-2">{topRight}</div>
          </header>
          <div className="flex-1 min-h-0 px-2 pb-2 flex flex-col">{children}</div>
        </main>
      </div>
    </Tooltip.Provider>
  )
}

function SidebarBody({
  items,
  secondary,
  children,
  footer,
  minimized = false,
  onToggle,
}: SidebarProps & { minimized?: boolean; onToggle?: () => void }) {
  return (
    <>
      <div
        className={`flex items-center px-1.5 pt-1 pb-1.5 ${minimized ? 'flex-col gap-1.5' : 'justify-between'}`}
      >
        <span className="flex h-4 w-4 rounded-full bg-accent" aria-hidden="true" />
        {onToggle && (
          <Button
            variant="icon"
            aria-label={minimized ? 'Expand sidebar' : 'Minimise sidebar'}
            onClick={onToggle}
          >
            {minimized ? <DoubleArrowRightIcon /> : <DoubleArrowLeftIcon />}
          </Button>
        )}
      </div>

      <nav className="flex flex-col gap-0.5">
        {items.map((it) => (
          <NavRow key={it.label} item={it} minimized={minimized} />
        ))}
      </nav>

      {secondary && secondary.length > 0 && (
        <>
          <Separator.Root className="my-1.5 h-px bg-line" />
          <nav className="flex flex-col gap-0.5">
            {secondary.map((it) => (
              <NavRow key={it.label} item={it} minimized={minimized} />
            ))}
          </nav>
        </>
      )}

      {children && !minimized && <div className="mt-1.5">{children}</div>}

      {footer && !minimized && (
        <button
          type="button"
          onClick={footer.onSelect}
          className="mt-1.5 w-full text-left rounded-xl bg-page border border-line p-2.5 flex items-start gap-2 hover:shadow-[var(--shadow-card)] transition"
        >
          <Mascot size={20} className="mt-px shrink-0" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">{footer.title}</span>
            <span className="block text-[11px] text-mist truncate">{footer.subtitle}</span>
          </span>
        </button>
      )}
    </>
  )
}

function NavRow({ item, minimized }: { item: NavItem; minimized: boolean }) {
  const base = `flex items-center rounded-lg text-[13px] transition ${
    item.active ? 'bg-accent-3 text-accent-ink' : 'text-ink-2 hover:bg-panel hover:text-ink'
  } ${minimized ? 'h-8 w-full justify-center' : 'gap-2 px-2.5 py-1.5'}`
  const inner = (
    <>
      <span className="text-mist [&>svg]:h-3.5 [&>svg]:w-3.5">{item.icon}</span>
      {!minimized && item.label}
    </>
  )
  const el = item.href ? (
    <Link href={item.href} className={base} aria-label={item.label}>
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={item.onSelect}
      className={`${base} text-left`}
      aria-label={item.label}
    >
      {inner}
    </button>
  )
  return minimized ? <WithTip label={item.label}>{el}</WithTip> : el
}

function WithTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={6}
          className="surface rounded-lg px-2 py-1 text-xs text-ink"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function Drawer({ sidebar }: { sidebar: SidebarProps }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="icon" aria-label="Open menu">
          <HamburgerMenuIcon />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/25" />
        <Dialog.Content className="card fixed left-2 top-2 w-[240px] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-2xl p-1.5 flex flex-col outline-none fade-up">
          <Dialog.Title className="sr-only">Menu</Dialog.Title>
          <Dialog.Close asChild>
            <Button variant="icon" aria-label="Close menu" className="absolute right-2 top-2">
              <Cross2Icon />
            </Button>
          </Dialog.Close>
          <SidebarBody {...sidebar} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
