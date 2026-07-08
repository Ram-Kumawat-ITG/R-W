import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from './services/ApiService.jsx'
import { titleCase } from './format.js'

// ── Data hook ────────────────────────────────────────────────────────────────
// Fetch a portal endpoint; re-fetch when params change. On 401/403 it calls
// onAuthError so the shell can switch to the sign-in / restricted screen.
export function useResource(path, params, onAuthError) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const reqId = useRef(0)
  const key = JSON.stringify(params || {})

  const load = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    setError(null)
    try {
      const result = await apiGet(path, params)
      if (id === reqId.current) setData(result)
    } catch (err) {
      if (id !== reqId.current) return
      if (err instanceof ApiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
        onAuthError?.(err)
        return
      }
      setError(err?.message || 'Failed to load data')
    } finally {
      if (id === reqId.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key])

  useEffect(() => {
    load()
  }, [load])

  return { data, loading, error, reload: load }
}

export function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// ── Presentational helpers ───────────────────────────────────────────────────

export function Tabs({ tabs, selected, onSelect }) {
  return (
    <div className="portal-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`portal-tab${t.id === selected ? ' is-active' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="portal-loading">
      <span className="portal-spinner" aria-hidden="true" />
      <span className="portal-muted">{label}</span>
    </div>
  )
}

export function Banner({ tone = 'info', heading, children }) {
  const icon = tone === 'critical' ? '!' : tone === 'warning' ? '!' : 'i'
  return (
    <div className={`portal-banner portal-banner--${tone}`}>
      <span className="portal-banner__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="portal-banner__body">
        {heading ? <h3>{heading}</h3> : null}
        {children}
      </div>
    </div>
  )
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <Banner tone="critical">
      <p>{message || 'Please try again.'}</p>
      {onRetry ? (
        <div className="portal-banner__action">
          <button type="button" className="portal-btn portal-btn--secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </Banner>
  )
}

const SUCCESS_STATES = new Set(['paid', 'active', 'converted', 'settled', 'approved'])
const WARNING_STATES = new Set([
  'pending',
  'processing',
  'awaiting_approval',
  'awaiting_settlement',
  'draft',
  'paused',
])
const CRITICAL_STATES = new Set([
  'failed',
  'rejected',
  'declined',
  'error',
  'cancelled',
  'canceled',
  'expired',
  'archived',
])

export function StatusBadge({ value }) {
  if (!value) return <span className="portal-muted">—</span>
  const key = String(value).toLowerCase()
  const tone = CRITICAL_STATES.has(key)
    ? 'critical'
    : WARNING_STATES.has(key)
      ? 'warning'
      : SUCCESS_STATES.has(key)
        ? 'success'
        : 'neutral'
  return (
    <span className={`portal-badge portal-badge--${tone}`}>
      <span className="portal-badge__dot" aria-hidden="true" />
      {titleCase(value)}
    </span>
  )
}

export function StatCard({ label, value, sub, tone = 'neutral' }) {
  return (
    <div className={`portal-stat-card portal-stat-card--${tone}`}>
      <div className="portal-muted portal-stat-card__label">{label}</div>
      <div className="portal-stat-card__value">{value}</div>
      {sub ? <div className="portal-muted portal-stat-card__sub">{sub}</div> : null}
    </div>
  )
}

export function StatCards({ cards }) {
  return (
    <div className="portal-stat-grid">
      {cards.map((c) => (
        <StatCard key={c.label} label={c.label} value={c.value} sub={c.sub} tone={c.tone} />
      ))}
    </div>
  )
}

// columns: { key, label, width?, align?: 'left'|'right'|'center', render?(row) }
// renderExpanded?(row): optional. When it returns content for a row, that row
//   becomes clickable and toggles an expandable panel beneath it.
export function Table({ columns, rows, empty = 'No data yet.', renderExpanded }) {
  const [open, setOpen] = useState({})
  if (!rows || rows.length === 0) {
    return <div className="portal-empty">{empty}</div>
  }
  const expandable = typeof renderExpanded === 'function'
  const toggle = (id) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
  const alignClass = (c) => (c.align && c.align !== 'left' ? ` portal-table__cell--${c.align}` : '')

  const hasWidths = columns.some((c) => c.width)

  return (
    <div className="portal-table-wrap">
      <div className="portal-table-scroll">
        <table className={hasWidths ? 'portal-table portal-table--fixed' : 'portal-table'}>
          {hasWidths ? (
            <colgroup>
              {columns.map((c) => (
                <col key={c.key} style={c.width ? { width: c.width } : undefined} />
              ))}
              {expandable ? <col style={{ width: '28px' }} /> : null}
            </colgroup>
          ) : null}
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={alignClass(c).trim()}>
                  {c.label}
                </th>
              ))}
              {expandable ? <th aria-hidden="true" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const id = row.id || i
              const expandedContent = expandable ? renderExpanded(row) : null
              const hasContent = !!expandedContent
              const isOpen = hasContent && !!open[id]
              return (
                <Fragment key={id}>
                  <tr
                    className={hasContent ? 'is-clickable' : undefined}
                    onClick={hasContent ? () => toggle(id) : undefined}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={alignClass(c).trim() || undefined}>
                        {c.render ? c.render(row) : (row[c.key] ?? '—')}
                      </td>
                    ))}
                    {expandable ? (
                      <td className="portal-table__chevron">{hasContent ? (isOpen ? '▾' : '▸') : null}</td>
                    ) : null}
                  </tr>
                  {isOpen ? (
                    <tr className="portal-table__expanded-row">
                      <td colSpan={columns.length + (expandable ? 1 : 0)}>{expandedContent}</td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function Pagination({ page = 1, totalPages = 1, total = 0, loading, onPage }) {
  if (totalPages <= 1) return null
  return (
    <div className="portal-pagination">
      <button
        type="button"
        className="portal-btn portal-btn--secondary"
        disabled={page <= 1 || loading}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <span className="portal-muted">
        Page {page} of {totalPages}
        {total ? ` · ${total} total` : ''}
      </span>
      <button
        type="button"
        className="portal-btn portal-btn--secondary"
        disabled={page >= totalPages || loading}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  )
}
