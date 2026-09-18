import { QuizRoom } from '@/components/QuizRoom'

export default async function QuizPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ name?: string }>
}) {
  const { id } = await params
  const { name } = await searchParams
  return <QuizRoom quizId={decodeURIComponent(id)} initialName={name ?? ''} />
}
