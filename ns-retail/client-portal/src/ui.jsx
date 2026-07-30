import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from './services/ApiService.jsx'
import { titleCase } from './format.js'

// ── Data hook ────────────────────────────────────────────────────────────────
// Fetch a portal endpoint; re-fetch when params change. On 401 it calls
// onAuthError so the shell can switch to the sign-in screen.
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
      if (err instanceof ApiError && err.httpStatus === 401) {
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
    <div className="cp-tabs">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`cp-tab${t.id === selected ? ' is-active' : ''}`}
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
    <div className="cp-loading">
      <span className="cp-spinner" aria-hidden="true" />
      <span className="cp-muted">{label}</span>
    </div>
  )
}

export function Banner({ tone = 'info', heading, children }) {
  const icon = tone === 'critical' ? '!' : tone === 'warning' ? '!' : 'i'
  return (
    <div className={`cp-banner cp-banner--${tone}`}>
      <span className="cp-banner__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="cp-banner__body">
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
        <div className="cp-banner__action">
          <button type="button" className="cp-btn cp-btn--secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
    </Banner>
  )
}

// Status vocabulary spans order/payment/fulfillment/CDO states (this portal
// has no commission/payout tab, unlike the wholesale Practitioner Portal
// this was ported from).
const SUCCESS_STATES = new Set(['paid', 'active', 'fulfilled', 'delivered', 'complete', 'completed'])
const WARNING_STATES = new Set([
  'pending',
  'processing',
  'partial',
  'partially_paid',
  'partially_fulfilled',
  'open',
  'in_transit',
  'out_for_delivery',
  'awaiting_settlement',
])
const CRITICAL_STATES = new Set([
  'failed',
  'declined',
  'error',
  'cancelled',
  'canceled',
  'refunded',
  'voided',
  'expired',
])

export function StatusBadge({ value }) {
  if (!value) return <span className="cp-muted">—</span>
  const key = String(value).toLowerCase()
  const tone = CRITICAL_STATES.has(key)
    ? 'critical'
    : WARNING_STATES.has(key)
      ? 'warning'
      : SUCCESS_STATES.has(key)
        ? 'success'
        : 'neutral'
  return (
    <span className={`cp-badge cp-badge--${tone}`}>
      <span className="cp-badge__dot" aria-hidden="true" />
      {titleCase(value)}
    </span>
  )
}

export function StatCard({ label, value, sub, tone = 'neutral' }) {
  return (
    <div className={`cp-stat-card cp-stat-card--${tone}`}>
      <div className="cp-muted cp-stat-card__label">{label}</div>
      <div className="cp-stat-card__value">{value}</div>
      {sub ? <div className="cp-muted cp-stat-card__sub">{sub}</div> : null}
    </div>
  )
}

export function StatCards({ cards }) {
  return (
    <div className="cp-stat-grid">
      {cards.map((c) => (
        <StatCard key={c.label} label={c.label} value={c.value} sub={c.sub} tone={c.tone} />
      ))}
    </div>
  )
}

// columns: { key, label, width?, align?: 'left'|'right'|'center', render?(row) }
// renderExpanded?(row): optional. When it returns content for a row, that row
//   becomes clickable and toggles an expandable panel beneath it.
// onRowClick?(row): optional. Alternative to renderExpanded — navigates
//   instead of expanding in place (used for order → order-detail).
export function Table({ columns, rows, empty = 'No data yet.', renderExpanded, onRowClick }) {
  const [open, setOpen] = useState({})
  if (!rows || rows.length === 0) {
    return <div className="cp-empty">{empty}</div>
  }
  const expandable = typeof renderExpanded === 'function'
  const toggle = (id) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))
  const alignClass = (c) => (c.align && c.align !== 'left' ? ` cp-table__cell--${c.align}` : '')

  const hasWidths = columns.some((c) => c.width)

  return (
    <div className="cp-table-wrap">
      <div className="cp-table-scroll">
        <table className={hasWidths ? 'cp-table cp-table--fixed' : 'cp-table'}>
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
              const handleClick = expandable
                ? hasContent
                  ? () => toggle(id)
                  : undefined
                : onRowClick
                  ? () => onRowClick(row)
                  : undefined
              return (
                <Fragment key={id}>
                  <tr className={handleClick ? 'is-clickable' : undefined} onClick={handleClick}>
                    {columns.map((c) => (
                      <td key={c.key} className={alignClass(c).trim() || undefined}>
                        {c.render ? c.render(row) : (row[c.key] ?? '—')}
                      </td>
                    ))}
                    {expandable ? (
                      <td className="cp-table__chevron">{hasContent ? (isOpen ? '▾' : '▸') : null}</td>
                    ) : null}
                  </tr>
                  {isOpen ? (
                    <tr className="cp-table__expanded-row">
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
    <div className="cp-pagination">
      <button
        type="button"
        className="cp-btn cp-btn--secondary"
        disabled={page <= 1 || loading}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </button>
      <span className="cp-muted">
        Page {page} of {totalPages}
        {total ? ` · ${total} total` : ''}
      </span>
      <button
        type="button"
        className="cp-btn cp-btn--secondary"
        disabled={page >= totalPages || loading}
        onClick={() => onPage(page + 1)}
      >
        Next
      </button>
    </div>
  )
}
