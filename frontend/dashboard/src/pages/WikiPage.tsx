import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { marked } from 'marked'

interface Article {
  slug: string
  title: string
  category: string
  description: string
}

// ── Category metadata ──────────────────────────────────────────────────────────
const CAT_META: Record<string, { color: string; bg: string; border: string; activeBg: string; icon: React.ReactNode }> = {
  Administration: {
    color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-200',
    activeBg: 'bg-violet-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  },
  Configuration: {
    color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200',
    activeBg: 'bg-blue-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h6"/><circle cx="19" cy="18" r="3"/><path d="M19 15v3M16 18h3"/></svg>,
  },
  'SNMP Setup': {
    color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200',
    activeBg: 'bg-emerald-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/></svg>,
  },
  'Syslog Setup': {
    color: 'text-teal-600', bg: 'bg-teal-50', border: 'border-teal-200',
    activeBg: 'bg-teal-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h6"/></svg>,
  },
  'Flow Setup': {
    color: 'text-cyan-600', bg: 'bg-cyan-50', border: 'border-cyan-200',
    activeBg: 'bg-cyan-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
  },
  Troubleshooting: {
    color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200',
    activeBg: 'bg-orange-50',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>,
  },
  Reference: {
    color: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-200',
    activeBg: 'bg-slate-100',
    icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
  },
}

const CATEGORY_ORDER = Object.keys(CAT_META)

const CAT_CARD_ACCENT: Record<string, string> = {
  Administration:  'group-hover:border-l-violet-400',
  Configuration:   'group-hover:border-l-blue-400',
  'SNMP Setup':    'group-hover:border-l-emerald-400',
  'Syslog Setup':  'group-hover:border-l-teal-400',
  'Flow Setup':    'group-hover:border-l-cyan-400',
  Troubleshooting: 'group-hover:border-l-orange-400',
  Reference:       'group-hover:border-l-slate-400',
}

export default function WikiPage() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate  = useNavigate()
  const contentRef = useRef<HTMLDivElement>(null)

  const [articles, setArticles]   = useState<Article[]>([])
  const [search, setSearch]       = useState('')
  const [content, setContent]     = useState<string | null>(null)
  const [loading, setLoading]     = useState(false)
  const [openCats, setOpenCats]   = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch('/wiki/index.json')
      .then(r => r.json())
      .then((data: Article[]) => {
        setArticles(data)
        const cats: Record<string, boolean> = {}
        data.forEach(a => { cats[a.category] = true })
        setOpenCats(cats)
      })
      .catch(() => setArticles([]))
  }, [])

  useEffect(() => {
    if (!slug) { setContent(null); return }
    setLoading(true)
    fetch(`/wiki/${slug}.md`)
      .then(r => r.ok ? r.text() : Promise.reject())
      .then(md => setContent(md))
      .catch(() => setContent(null))
      .finally(() => setLoading(false))
  }, [slug])

  // Intercept internal wiki links
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = (e: MouseEvent) => {
      const a = (e.target as Element).closest('a')
      if (!a) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('#')) return
      e.preventDefault()
      navigate(`/wiki/${href}`)
    }
    el.addEventListener('click', handler)
    return () => el.removeEventListener('click', handler)
  }, [content, navigate])

  useEffect(() => { contentRef.current?.scrollTo(0, 0) }, [slug])

  const filtered = articles.filter(a =>
    !search ||
    a.title.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase()) ||
    a.category.toLowerCase().includes(search.toLowerCase())
  )

  const byCategory = CATEGORY_ORDER.reduce<Record<string, Article[]>>((acc, cat) => {
    acc[cat] = filtered.filter(a => a.category === cat)
    return acc
  }, {})

  const activeArticle  = articles.find(a => a.slug === slug)
  const activeMeta     = activeArticle ? (CAT_META[activeArticle.category] ?? CAT_META.Reference) : null
  const renderedHtml   = content ? marked(content) as string : null
  const toggleCat      = (cat: string) => setOpenCats(prev => ({ ...prev, [cat]: !prev[cat] }))

  return (
    <div className="flex h-full min-h-screen bg-slate-50">

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <aside className="hidden md:flex flex-col w-64 xl:w-72 shrink-0 bg-white border-r border-slate-200 h-screen sticky top-0 overflow-hidden">

        {/* Brand */}
        <div className="px-4 pt-5 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-sm">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800 leading-none">Wiki</p>
              <p className="text-[10px] text-slate-400 mt-0.5">{articles.length} articles</p>
            </div>
          </div>
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:bg-white placeholder:text-slate-400 transition-colors"
            />
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {CATEGORY_ORDER.map(cat => {
            const items = byCategory[cat] ?? []
            if (search && items.length === 0) return null
            const open = openCats[cat] ?? true
            const meta = CAT_META[cat] ?? CAT_META.Reference
            return (
              <div key={cat} className="mb-0.5">
                <button
                  onClick={() => toggleCat(cat)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 transition-colors group"
                >
                  <span className={`${meta.color} opacity-70 group-hover:opacity-100 transition-opacity`}>{meta.icon}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 group-hover:text-slate-600 flex-1 text-left transition-colors">{cat}</span>
                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full tabular-nums ${meta.bg} ${meta.color}`}>{items.length}</span>
                  <svg className={`w-3 h-3 text-slate-300 shrink-0 transition-transform duration-150 ${open ? '' : '-rotate-90'}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div className={`overflow-hidden transition-all duration-200 ${open ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'}`}>
                  <div className="ml-2 pl-2.5 border-l-2 border-slate-100 space-y-0.5 py-1">
                    {items.map(a => {
                      const isActive = slug === a.slug
                      return (
                        <button
                          key={a.slug}
                          onClick={() => navigate(`/wiki/${a.slug}`)}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                            isActive
                              ? `${meta.activeBg} ${meta.color} font-semibold`
                              : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                          }`}
                        >
                          <span className="block truncate leading-snug">{a.title}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
          {search && filtered.length === 0 && (
            <p className="text-center text-xs text-slate-400 py-8">No results for "{search}"</p>
          )}
        </nav>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────────── */}
      <main ref={contentRef} className="flex-1 overflow-y-auto">

        {!slug ? (
          /* ── Landing ── */
          <>
            {/* Hero */}
            <div className="relative overflow-hidden bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700">
              <div className="absolute inset-0 opacity-10"
                style={{ backgroundImage: 'radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
              <div className="relative max-w-4xl mx-auto px-6 py-14">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                    </svg>
                  </div>
                  <span className="text-white/60 text-sm font-medium">Anthrimon Documentation</span>
                </div>
                <h1 className="text-3xl font-bold text-white mb-2">How can we help?</h1>
                <p className="text-indigo-200 mb-8 text-sm">Administration guides, vendor configuration references, and troubleshooting runbooks.</p>
                {/* Hero search */}
                <div className="relative max-w-xl">
                  <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search all articles…"
                    className="w-full pl-10 pr-4 py-3 text-sm bg-white rounded-xl shadow-lg focus:outline-none focus:ring-2 focus:ring-white/50 placeholder:text-slate-400"
                  />
                  {search && (
                    <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
                {/* Stats */}
                <div className="flex items-center gap-6 mt-6">
                  {[
                    { n: articles.length, label: 'articles' },
                    { n: CATEGORY_ORDER.length, label: 'categories' },
                    { n: articles.filter(a => a.category === 'Troubleshooting').length, label: 'troubleshooting guides' },
                  ].map(s => (
                    <div key={s.label} className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold text-white tabular-nums">{s.n}</span>
                      <span className="text-indigo-300 text-xs">{s.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Category grid */}
            <div className="max-w-4xl mx-auto px-6 py-10 space-y-10">
              {CATEGORY_ORDER.map(cat => {
                const items = byCategory[cat] ?? []
                if (items.length === 0) return null
                const meta = CAT_META[cat] ?? CAT_META.Reference
                return (
                  <div key={cat}>
                    {/* Category header */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-7 h-7 rounded-lg ${meta.bg} border ${meta.border} flex items-center justify-center ${meta.color}`}>
                        {meta.icon}
                      </div>
                      <h2 className="text-sm font-bold text-slate-700">{cat}</h2>
                      <div className="flex-1 h-px bg-slate-200" />
                      <span className="text-xs text-slate-400 tabular-nums">{items.length}</span>
                    </div>
                    {/* Cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {items.map(a => (
                        <button
                          key={a.slug}
                          onClick={() => navigate(`/wiki/${a.slug}`)}
                          className={`group text-left bg-white rounded-xl border border-l-4 border-slate-200 border-l-slate-200 ${CAT_CARD_ACCENT[cat]} hover:shadow-md transition-all duration-150 p-4`}
                        >
                          <p className={`text-sm font-semibold text-slate-800 group-hover:${meta.color} transition-colors mb-1 leading-snug`}>{a.title}</p>
                          <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">{a.description}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </>

        ) : loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
              Loading…
            </div>
          </div>

        ) : !renderedHtml ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
            </div>
            <p className="text-sm font-medium text-slate-600">Article not found</p>
            <button onClick={() => navigate('/wiki')} className="text-xs text-indigo-500 hover:text-indigo-700 transition-colors">← Back to index</button>
          </div>

        ) : (
          /* ── Article view ── */
          <>
            {/* Article header bar */}
            {activeMeta && activeArticle && (
              <div className={`border-b ${activeMeta.border} ${activeMeta.bg}`}>
                <div className="max-w-3xl mx-auto px-6 py-5">
                  {/* Breadcrumb */}
                  <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-3">
                    <button onClick={() => navigate('/wiki')} className="hover:text-indigo-600 transition-colors flex items-center gap-1">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                      Wiki
                    </button>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                    <span className={`${activeMeta.color} font-medium`}>{activeArticle.category}</span>
                  </div>
                  {/* Title + badge */}
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-xl ${activeMeta.bg} border ${activeMeta.border} flex items-center justify-center ${activeMeta.color} shrink-0 mt-0.5`}>
                      {activeMeta.icon}
                    </div>
                    <div>
                      <h1 className="text-xl font-bold text-slate-800 leading-tight">{activeArticle.title}</h1>
                      <p className="text-sm text-slate-500 mt-0.5">{activeArticle.description}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Article body */}
            <div className="max-w-3xl mx-auto px-6 py-8">
              <div
                className="prose prose-slate prose-sm max-w-none
                  prose-headings:font-bold prose-headings:text-slate-800
                  prose-h1:hidden
                  prose-h2:text-base prose-h2:mt-8 prose-h2:mb-3 prose-h2:pb-2 prose-h2:border-b prose-h2:border-slate-100
                  prose-h3:text-sm prose-h3:mt-6 prose-h3:mb-2 prose-h3:text-slate-700
                  prose-p:text-slate-600 prose-p:leading-relaxed prose-p:my-3
                  prose-a:text-indigo-600 prose-a:font-medium prose-a:no-underline hover:prose-a:underline
                  prose-strong:text-slate-800 prose-strong:font-semibold
                  prose-code:text-indigo-700 prose-code:bg-indigo-50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:text-[0.8em] prose-code:font-mono prose-code:border prose-code:border-indigo-100
                  prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-pre:rounded-xl prose-pre:shadow-lg prose-pre:overflow-x-auto prose-pre:my-5
                  prose-pre:prose-code:bg-transparent prose-pre:prose-code:text-slate-100 prose-pre:prose-code:p-0 prose-pre:prose-code:border-0
                  prose-table:text-sm prose-table:w-full prose-table:border prose-table:border-slate-200 prose-table:rounded-lg prose-table:overflow-hidden
                  prose-thead:bg-slate-50
                  prose-th:text-left prose-th:font-semibold prose-th:text-slate-700 prose-th:px-4 prose-th:py-2.5 prose-th:text-xs prose-th:uppercase prose-th:tracking-wide
                  prose-td:px-4 prose-td:py-2.5 prose-td:border-b prose-td:border-slate-100 prose-td:text-slate-600
                  prose-ul:text-slate-600 prose-ol:text-slate-600 prose-li:my-1
                  prose-blockquote:border-l-4 prose-blockquote:border-l-indigo-300 prose-blockquote:bg-indigo-50 prose-blockquote:rounded-r-xl prose-blockquote:text-slate-600 prose-blockquote:not-italic prose-blockquote:py-1 prose-blockquote:px-1
                  prose-hr:border-slate-200"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />

              {/* Prev / Next */}
              {activeArticle && (() => {
                const catItems = articles.filter(a => a.category === activeArticle.category)
                const idx  = catItems.findIndex(a => a.slug === slug)
                const prev = idx > 0 ? catItems[idx - 1] : null
                const next = idx < catItems.length - 1 ? catItems[idx + 1] : null
                if (!prev && !next) return null
                return (
                  <div className="mt-12 pt-6 border-t border-slate-200 grid grid-cols-2 gap-3">
                    {prev ? (
                      <button onClick={() => navigate(`/wiki/${prev.slug}`)}
                        className="group text-left bg-white border border-slate-200 hover:border-indigo-200 hover:shadow-sm rounded-xl p-4 transition-all">
                        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
                          Previous
                        </div>
                        <p className="text-sm font-semibold text-slate-700 group-hover:text-indigo-600 transition-colors leading-snug">{prev.title}</p>
                      </button>
                    ) : <div />}
                    {next ? (
                      <button onClick={() => navigate(`/wiki/${next.slug}`)}
                        className="group text-right bg-white border border-slate-200 hover:border-indigo-200 hover:shadow-sm rounded-xl p-4 transition-all col-start-2">
                        <div className="flex items-center justify-end gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
                          Next
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                        </div>
                        <p className="text-sm font-semibold text-slate-700 group-hover:text-indigo-600 transition-colors leading-snug">{next.title}</p>
                      </button>
                    ) : <div />}
                  </div>
                )
              })()}

              {/* Back link */}
              <div className="mt-8 pt-4">
                <button onClick={() => navigate('/wiki')}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-indigo-600 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>
                  Back to all articles
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
