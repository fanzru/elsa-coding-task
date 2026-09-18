'use client'

import type { QuizSummary } from '@quiz/protocol'
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons'
import { Select } from 'radix-ui'

export function QuizSelect({
  quizzes,
  value,
  onChange,
}: {
  quizzes: QuizSummary[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        aria-label="Quiz"
        className="inline-flex w-full items-center justify-between gap-2 rounded-lg bg-panel border border-line px-3.5 h-9 text-[13px] text-ink outline-none data-[state=open]:bg-canvas data-[state=open]:border-accent"
      >
        <Select.Value placeholder="Choose a quiz" />
        <Select.Icon className="text-mist">
          <ChevronDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          className="surface z-50 w-[var(--radix-select-trigger-width)] p-1"
        >
          <Select.Viewport>
            {quizzes.map((q) => (
              <Select.Item
                key={q.id}
                value={q.id}
                className="relative flex cursor-default select-none items-center rounded-lg py-1.5 pl-2.5 pr-8 text-[13px] text-ink outline-none data-[highlighted]:bg-accent-3"
              >
                <Select.ItemText>
                  {q.title} <span className="text-mist">· {q.totalQuestions} questions</span>
                </Select.ItemText>
                <Select.ItemIndicator className="absolute right-3 text-ink">
                  <CheckIcon />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
