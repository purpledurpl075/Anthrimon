import type { MetricWidgetConfig } from './metricWidgetConfig'

interface TextNoteProps {
  config:   MetricWidgetConfig
  editing?: boolean
  onChange?: (text: string) => void
}

export function TextNote({ config, editing, onChange }: TextNoteProps) {
  const text = config.text ?? ''

  if (editing) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full flex flex-col">
        {config.title && <h3 className="text-sm font-semibold text-slate-800 mb-2 truncate">{config.title}</h3>}
        <textarea
          value={text}
          onChange={e => onChange?.(e.target.value)}
          placeholder="Write a note…"
          className="flex-1 w-full resize-none border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 h-full overflow-auto">
      {config.title && <h3 className="text-sm font-semibold text-slate-800 mb-2 truncate">{config.title}</h3>}
      {text ? (
        <div className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{text}</div>
      ) : (
        <p className="text-xs text-slate-400">Empty note — click configure to add text</p>
      )}
    </div>
  )
}
