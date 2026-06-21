interface ErrorStateProps {
  message?: string
  onRetry?: () => void
  inline?: boolean
}

export default function ErrorState({ message = 'Something went wrong.', onRetry, inline }: ErrorStateProps) {
  const wrapper = inline
    ? 'px-6 py-8 text-center'
    : 'flex flex-col items-center justify-center p-8 gap-3'

  return (
    <div className={wrapper}>
      <div className="flex items-center justify-center gap-2 text-sm text-red-600">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0">
          <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
        </svg>
        <span>{message}</span>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  )
}
