export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return <section className={`card rounded-2xl ${className}`}>{children}</section>
}
