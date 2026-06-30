/* global shopify */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { apiGet, ApiError } from '../../services/FullPageApi.jsx'
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

// Underlined tab bar. The customer-account surface has no native Tabs
// component, so this is built from Clickable + Box border props (the sandbox
// forbids custom CSS). A faint shared baseline runs under the whole row; the
// active tab carries a thick `strong`-colored bottom border as the indicator.
export function Tabs({ tabs, selected, onSelect }) {
  return (
    <s-box borderWidth="none none base none" border="base subdued">
      <s-stack direction="inline" gap="base">
        {tabs.map((t) => {
          const active = t.id === selected
          return (
            <s-clickable
              key={t.id}
              onClick={() => onSelect(t.id)}
              background="transparent"
              paddingInline="base"
              paddingBlock="small-300"
              border={active ? 'large strong' : undefined}
              borderWidth={active ? 'none none large none' : undefined}
              accessibilityLabel={t.label}
            >
              <s-text type={active ? 'strong' : 'generic'} color={active ? 'base' : 'subdued'}>
                {t.label}
              </s-text>
            </s-clickable>
          )
        })}
      </s-stack>
    </s-box>
  )
}

export function Loading({ label = 'Loading…' }) {
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-spinner accessibilityLabel={label} />
      <s-text color="subdued">{label}</s-text>
    </s-stack>
  )
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <s-banner tone="critical" heading="Something went wrong">
      <s-stack direction="block" gap="base">
        <s-text>{message || 'Please try again.'}</s-text>
        {onRetry ? (
          <s-button onClick={onRetry}>Retry</s-button>
        ) : null}
      </s-stack>
    </s-banner>
  )
}

// The customer-account `s-badge` only supports tone 'auto' | 'neutral' |
// 'critical' (no success/warning/info on this surface) — anything else
// silently renders as default grey. So we flag failures as critical and leave
// everything else neutral, relying on the (Title-Cased) label to convey state.
const CRITICAL_STATES = new Set([
  'failed',
  'rejected',
  'declined',
  'error',
  'cancelled',
  'canceled',
])

export function StatusBadge({ value }) {
  if (!value) return <s-text color="subdued">—</s-text>
  const tone = CRITICAL_STATES.has(String(value).toLowerCase()) ? 'critical' : 'neutral'
  return <s-badge tone={tone}>{titleCase(value)}</s-badge>
}

export function StatCard({ label, value, sub }) {
  return (
    <s-box padding="base" borderRadius="base" border="base" background="subdued">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub ? <s-text color="subdued">{sub}</s-text> : null}
      </s-stack>
    </s-box>
  )
}

export function StatCards({ cards }) {
  return (
    <s-grid gridTemplateColumns="1fr 1fr" gap="base">
      {cards.map((c) => (
        <StatCard key={c.label} label={c.label} value={c.value} sub={c.sub} />
      ))}
    </s-grid>
  )
}

// Table built from s-grid (the sandbox has no arbitrary HTML/<table>).
// columns: { key, label, width?, render?(row) }
// renderExpanded?(row): optional. When it returns content for a row, that row
//   becomes clickable and toggles an expandable panel beneath it (a trailing
//   ▸/▾ chevron marks which rows expand). Tables that don't pass it are
//   rendered exactly as before.
export function Table({ columns, rows, empty = 'No data yet.', renderExpanded }) {
  const [open, setOpen] = useState({})
  if (!rows || rows.length === 0) {
    return <s-text color="subdued">{empty}</s-text>
  }
  const expandable = typeof renderExpanded === 'function'
  const baseTemplate = columns.map((c) => c.width || '1fr').join(' ')
  // Trailing auto-width track holds the disclosure chevron when expandable.
  const template = expandable ? `${baseTemplate} auto` : baseTemplate
  const toggle = (id) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))

  // The grid of value cells for one row (+ the chevron cell when expandable).
  const rowGrid = (row, isOpen, hasContent) => (
    <s-grid gridTemplateColumns={template} gap="base">
      {columns.map((c) => (
        <s-box key={c.key}>
          {c.render ? c.render(row) : <s-text>{row[c.key] ?? '—'}</s-text>}
        </s-box>
      ))}
      {expandable ? (
        <s-box>
          {hasContent ? (
            <s-text color="subdued">{isOpen ? '▾' : '▸'}</s-text>
          ) : null}
        </s-box>
      ) : null}
    </s-grid>
  )

  return (
    <s-stack direction="block" gap="small-300">
      <s-grid gridTemplateColumns={template} gap="base">
        {columns.map((c) => (
          <s-text key={c.key} type="strong" color="subdued">
            {c.label}
          </s-text>
        ))}
        {expandable ? <s-text> </s-text> : null}
      </s-grid>
      <s-divider />
      {rows.map((row, i) => {
        const id = row.id || i
        if (!expandable) {
          return [
            <s-grid key={`r-${id}`} gridTemplateColumns={template} gap="base">
              {columns.map((c) => (
                <s-box key={c.key}>
                  {c.render ? c.render(row) : <s-text>{row[c.key] ?? '—'}</s-text>}
                </s-box>
              ))}
            </s-grid>,
            i < rows.length - 1 ? <s-divider key={`d-${id}`} /> : null,
          ]
        }
        const expandedContent = renderExpanded(row)
        const hasContent = !!expandedContent
        const isOpen = hasContent && !!open[id]
        return [
          hasContent ? (
            <s-clickable
              key={`r-${id}`}
              onClick={() => toggle(id)}
              background="transparent"
              paddingBlock="small-300"
              accessibilityLabel={isOpen ? 'Hide details' : 'Show details'}
            >
              {rowGrid(row, isOpen, true)}
            </s-clickable>
          ) : (
            <s-box key={`r-${id}`} paddingBlock="small-300">
              {rowGrid(row, false, false)}
            </s-box>
          ),
          isOpen ? (
            <s-box key={`e-${id}`} paddingBlockEnd="base" paddingInlineStart="base">
              {expandedContent}
            </s-box>
          ) : null,
          i < rows.length - 1 ? <s-divider key={`d-${id}`} /> : null,
        ]
      })}
    </s-stack>
  )
}

export function Pagination({ page = 1, totalPages = 1, total = 0, loading, onPage }) {
  if (totalPages <= 1) return null
  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-button disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>
        Previous
      </s-button>
      <s-text color="subdued">
        Page {page} of {totalPages}
        {total ? ` · ${total} total` : ''}
      </s-text>
      <s-button disabled={page >= totalPages || loading} onClick={() => onPage(page + 1)}>
        Next
      </s-button>
    </s-stack>
  )
}
