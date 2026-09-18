'use client'

import { Modal } from './Modal'

export function HowItWorks({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Quiz 101"
      description="How a session works and how points are scored."
    >
      <ol className="space-y-2 text-[13px] text-ink-2">
        <li className="flex gap-3">
          <span className="w-5 shrink-0 text-mist">1</span>
          Everyone with the code joins the same session. The countdown starts with the first player.
        </li>
        <li className="flex gap-3">
          <span className="w-5 shrink-0 text-mist">2</span>
          Each question is open for 15 seconds. A correct answer scores 1 000 points at 0 s, sliding
          down to 500 at the buzzer. Time is measured by the server.
        </li>
        <li className="flex gap-3">
          <span className="w-5 shrink-0 text-mist">3</span>
          Consecutive correct answers add a streak bonus: +10 % per answer, up to +50 %.
        </li>
        <li className="flex gap-3">
          <span className="w-5 shrink-0 text-mist">4</span>
          Only your first answer per question counts. Ties go to whoever reached the score first.
        </li>
        <li className="flex gap-3">
          <span className="w-5 shrink-0 text-mist">5</span>
          Refreshing or losing connection keeps your score — you rejoin where the session is.
        </li>
      </ol>
    </Modal>
  )
}
