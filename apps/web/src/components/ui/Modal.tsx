'use client'

import { Cross2Icon } from '@radix-ui/react-icons'
import { Dialog } from 'radix-ui'
import { Button } from './Button'

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/25 backdrop-blur-sm" />
        <Dialog.Content className="surface fixed left-1/2 top-1/2 w-[min(92vw,400px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none fade-up">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold tracking-tight">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-0.5 text-[13px] text-ink-2">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="icon" aria-label="Close">
                <Cross2Icon />
              </Button>
            </Dialog.Close>
          </div>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
