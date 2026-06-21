import { useEffect, type ReactNode } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  open: boolean
  onClose: () => void
  label: string
  children: ReactNode
  className?: string
}

export default function Modal({ open, onClose, label, children, className = 'w-full max-w-lg' }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-label={label}>
      <div ref={trapRef} className={`bg-white rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto ${className}`}
        onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
