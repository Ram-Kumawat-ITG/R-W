import { useState, useRef } from 'react'
import {
  useResource,
  useDebounced,
  Loading,
  ErrorBanner,
  Banner,
  StatusBadge,
  StatCards,
  Table,
  Pagination,
} from './ui.jsx'
import { apiPost, ApiError } from './services/ApiService.jsx'
import {
  formatMoney,
  formatDate,
  formatPercent,
  formatNumber,
  titleCase,
  payoutReasonMessage,
} from './format.js'

// Discount tiers offered when a practitioner creates a code. Kept in sync
// with the backend's PORTAL_DISCOUNT_PERCENTS (the storefront bundle can't
// import server modules) — update both if this list changes.
const DISCOUNT_PERCENTS = [10, 15, 20, 25, 30, 35, 40]

// Commission payout-status filter options (mirrors CdoCommission.payoutStatus).
const COMMISSION_PAYOUT_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Cancelled' },
]

// Payout-status filter options (mirrors CdoPayout.status; 'draft' is internal).
const PAYOUT_STATUSES = [
  { value: 'awaiting_approval', label: 'Awaiting approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'processing', label: 'Processing' },
  { value: 'awaiting_settlement', label: 'Awaiting settlement' },
  { value: 'paid', label: 'Paid' },
  { value: 'failed', label: 'Failed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
]

const labelFor = (options, value) =>
  options.find((o) => o.value === value)?.label || value

function SectionShell({ heading, description, children }) {
  return (
    <section className="portal-section">
      <h2 className="portal-section__heading">{heading}</h2>
      {description ? <p className="portal-muted">{description}</p> : null}
      <div className="portal-stack">{children}</div>
    </section>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
export function OverviewSection({ onAuthError }) {
  // `draft` = what's typed in the date inputs; `applied` = what the revenue
  // query actually uses. Filtering only runs on Apply; Reset clears both.
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [applied, setApplied] = useState({ from: '', to: '' })
  const summary = useResource('summary', null, onAuthError)
  const revenue = useResource('revenue', applied, onAuthError)

  if (summary.loading && !summary.data) return <Loading />
  if (summary.error) return <ErrorBanner message={summary.error} onRetry={summary.reload} />

  const s = summary.data || {}
  const r = revenue.data || {}

  const hasDraft = !!(draft.from || draft.to)
  const hasApplied = !!(applied.from || applied.to)
  const draftMatchesApplied = draft.from === applied.from && draft.to === applied.to
  const lifetimeOrders = Number(s.lifetimeOrders) || 0

  const applyRange = () => setApplied({ ...draft })
  const resetRange = () => {
    setDraft({ from: '', to: '' })
    setApplied({ from: '', to: '' })
  }

  return (
    <SectionShell heading="Overview" description="Your referral program, at a glance.">
      <StatCards
        cards={[
          { label: 'Referred patients', value: formatNumber(s.referredPatients), sub: 'Unique patients you referred', tone: 'purple' },
          {
            label: 'Lifetime revenue',
            value: formatMoney(s.lifetimeRevenue),
            sub: lifetimeOrders ? `From ${formatNumber(lifetimeOrders)} referred orders` : 'From referred orders',
            tone: 'blue',
          },
          { label: 'Total commission', value: formatMoney(s.totalCommission), sub: 'Earned to date (excludes reversed)', tone: 'green' },
          { label: 'Paid commission', value: formatMoney(s.paidCommission), sub: 'Already paid out to you', tone: 'green' },
          { label: 'Awaiting payout', value: formatMoney(s.awaitingPayoutCommission), sub: 'Approved — due in an upcoming payout', tone: 'amber' },
          { label: 'Pending commission', value: formatMoney(s.pendingCommission), sub: 'Accrued — awaiting approval', tone: 'amber' },
          { label: 'Active referral codes', value: formatNumber(s.activeReferralCodes), sub: 'Currently shareable', tone: 'purple' },
          { label: 'Revenue this month', value: formatMoney(s.revenueThisMonth), sub: 'Referred orders this month', tone: 'blue' },
        ]}
      />

      <div className="portal-stack">
        <div>
          <h3 className="portal-subheading">Revenue breakdown</h3>
          <p className="portal-muted">
            Revenue from your referred orders. Pick a From and/or To date and choose
            Apply to see a custom range; Reset clears the filter.
          </p>
        </div>

        <div className="portal-field-grid portal-field-grid--2">
          <label className="portal-field">
            <span>From</span>
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
            />
          </label>
          <label className="portal-field">
            <span>To</span>
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))}
            />
          </label>
        </div>

        <div className="portal-inline">
          <button
            type="button"
            className="portal-btn portal-btn--primary"
            disabled={!hasDraft || draftMatchesApplied || revenue.loading}
            onClick={applyRange}
          >
            Apply
          </button>
          <button
            type="button"
            className="portal-btn portal-btn--secondary"
            disabled={!hasDraft && !hasApplied}
            onClick={resetRange}
          >
            Reset
          </button>
        </div>

        {hasApplied ? (
          <Banner tone="info">
            <p>
              Showing revenue for {applied.from ? formatDate(applied.from) : 'the beginning'} →{' '}
              {applied.to ? formatDate(applied.to) : 'today'}.
            </p>
          </Banner>
        ) : null}

        {revenue.error ? (
          <ErrorBanner message={revenue.error} onRetry={revenue.reload} />
        ) : (
          <StatCards
            cards={[
              { label: 'This month', value: formatMoney(r.thisMonth), tone: 'blue' },
              { label: 'Last month', value: formatMoney(r.lastMonth), tone: 'blue' },
              { label: 'Current year', value: formatMoney(r.thisYear), tone: 'blue' },
              { label: 'Lifetime', value: formatMoney(r.lifetime), tone: 'blue' },
              ...(r.range !== null && r.range !== undefined
                ? [
                    {
                      label: 'Selected range',
                      value: formatMoney(r.range),
                      sub: `${applied.from ? formatDate(applied.from) : '…'} → ${
                        applied.to ? formatDate(applied.to) : '…'
                      }${r.rangeOrderCount != null ? ` · ${formatNumber(r.rangeOrderCount)} orders` : ''}`,
                      tone: 'purple',
                    },
                  ]
                : []),
            ]}
          />
        )}
      </div>
    </SectionShell>
  )
}

// Expandable panel shown beneath a patient row: their referral-code history.
function CodeHistory({ row }) {
  const codes = row.codes || []
  if (codes.length === 0) return null
  return (
    <div className="portal-stack portal-stack--tight">
      <span className="portal-strong portal-muted">Referral code history</span>
      {codes.map((c, i) => (
        <div key={`${c.code}-${i}`} className="portal-inline portal-inline--tight">
          <span className={i === 0 ? 'portal-strong' : undefined}>{c.code}</span>
          {i === 0 ? <span className="portal-badge portal-badge--neutral">Latest</span> : null}
          {c.usedAt ? <span className="portal-muted">{formatDate(c.usedAt)}</span> : null}
        </div>
      ))}
    </div>
  )
}

// ── Referred customers ───────────────────────────────────────────────────────
export function PatientsSection({ onAuthError }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const debounced = useDebounced(search)
  const { data, loading, error, reload } = useResource(
    'customers',
    { search: debounced, page, pageSize: 10 },
    onAuthError,
  )

  const rows = data?.rows || []
  const columns = [
    { key: 'name', label: 'Name', width: '20%', render: (r) => r.name || '—' },
    { key: 'email', label: 'Email', width: '26%', render: (r) => r.email || '—' },
    { key: 'referralCode', label: 'Code', width: '16%', render: (r) => r.referralCode || '—' },
    { key: 'registeredAt', label: 'Registered', width: '16%', render: (r) => formatDate(r.registeredAt) },
    { key: 'totalOrders', label: 'Orders', width: '10%', align: 'right', render: (r) => formatNumber(r.totalOrders) },
    { key: 'lifetimeValue', label: 'LTV', width: '12%', align: 'right', render: (r) => <span className="portal-strong">{formatMoney(r.lifetimeValue)}</span> },
  ]

  return (
    <SectionShell heading="Referred customers" description="Patients you have referred.">
      <label className="portal-field">
        <span>Search</span>
        <input
          type="text"
          placeholder="Search name or email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
      </label>
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="portal-stack">
          <Table
            columns={columns}
            rows={rows}
            empty="No referred customers yet."
            renderExpanded={(r) => (r.codes && r.codes.length > 0 ? <CodeHistory row={r} /> : null)}
          />
          <Pagination
            page={data?.page || 1}
            totalPages={data?.totalPages || 1}
            total={data?.total || 0}
            loading={loading}
            onPage={setPage}
          />
        </div>
      )}
    </SectionShell>
  )
}

// ── Commissions ──────────────────────────────────────────────────────────────
const EMPTY_COMMISSION_FILTERS = { patient: '', payoutStatus: '', from: '', to: '' }

export function CommissionsSection({ mode = 'all', onAuthError }) {
  const pendingOnly = mode === 'pending'
  const [draft, setDraft] = useState(EMPTY_COMMISSION_FILTERS)
  const [applied, setApplied] = useState(EMPTY_COMMISSION_FILTERS)
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'commissions',
    {
      pendingOnly: pendingOnly ? '1' : undefined,
      patient: applied.patient || undefined,
      payoutStatus: applied.payoutStatus || undefined,
      from: applied.from,
      to: applied.to,
      page,
      pageSize: 10,
    },
    onAuthError,
  )

  const rows = data?.rows || []
  const totals = data?.totals || {}
  const patients = data?.patients || []

  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.target.value }))
  const draftMatchesApplied =
    draft.patient === applied.patient &&
    draft.payoutStatus === applied.payoutStatus &&
    draft.from === applied.from &&
    draft.to === applied.to
  const hasDraft = !!(draft.patient || draft.payoutStatus || draft.from || draft.to)
  const hasApplied = !!(applied.patient || applied.payoutStatus || applied.from || applied.to)

  const applyFilters = () => {
    setApplied({ ...draft })
    setPage(1)
  }
  const resetFilters = () => {
    setDraft(EMPTY_COMMISSION_FILTERS)
    setApplied(EMPTY_COMMISSION_FILTERS)
    setPage(1)
  }

  const columns = [
    { key: 'orderName', label: 'Order', width: '20%', render: (r) => <span className="portal-strong">{r.orderName || '—'}</span> },
    {
      key: 'amount',
      label: pendingOnly ? 'Expected' : 'Amount',
      width: '16%',
      align: 'right',
      render: (r) => <span className="portal-strong">{formatMoney(r.amount)}</span>,
    },
    { key: 'rate', label: 'Rate', width: '12%', align: 'right', render: (r) => formatPercent(r.rate) },
    {
      key: 'payoutStatus',
      label: 'Payout status',
      width: '28%',
      render: (r) => (
        <div className="portal-stack portal-stack--tight">
          <StatusBadge value={r.payoutStatus || 'pending'} />
          {r.payoutStatus === 'failed' && r.payoutFailureReason ? (
            <span className="portal-muted">{payoutReasonMessage(r.payoutFailureReason)}</span>
          ) : null}
        </div>
      ),
    },
    { key: 'earnedAt', label: 'Earned on', width: '24%', render: (r) => formatDate(r.earnedAt) },
  ]

  return (
    <SectionShell
      heading={pendingOnly ? 'Pending commissions' : 'Commission summary'}
      description={
        pendingOnly
          ? 'Commissions earned but not yet paid out.'
          : 'Commissions you earned from referred orders. Filter by patient, payout status, or date, then choose Apply.'
      }
    >
      <StatCards
        cards={[
          { label: 'Total earned', value: formatMoney(totals.total), sub: 'Excludes reversed', tone: 'green' },
          { label: 'Paid', value: formatMoney(totals.paid), sub: 'Already paid out to you', tone: 'green' },
          { label: 'Awaiting payout', value: formatMoney(totals.awaitingPayout), sub: 'Approved — upcoming payout', tone: 'amber' },
          { label: 'Pending', value: formatMoney(totals.pending), sub: 'Awaiting approval', tone: 'amber' },
        ]}
      />

      <div className="portal-stack">
        <div className="portal-field-grid portal-field-grid--2">
          <label className="portal-field">
            <span>Patient</span>
            <select value={draft.patient} onChange={setField('patient')}>
              <option value="">All patients</option>
              {patients.map((pt) => (
                <option key={pt.value} value={pt.value}>
                  {pt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="portal-field">
            <span>Payout status</span>
            <select value={draft.payoutStatus} onChange={setField('payoutStatus')}>
              <option value="">All statuses</option>
              {COMMISSION_PAYOUT_STATUSES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="portal-field">
            <span>From</span>
            <input type="date" value={draft.from} onChange={setField('from')} />
          </label>
          <label className="portal-field">
            <span>To</span>
            <input type="date" value={draft.to} onChange={setField('to')} />
          </label>
        </div>
        <div className="portal-inline">
          <button
            type="button"
            className="portal-btn portal-btn--primary"
            disabled={draftMatchesApplied || loading}
            onClick={applyFilters}
          >
            Apply
          </button>
          <button
            type="button"
            className="portal-btn portal-btn--secondary"
            disabled={!hasDraft && !hasApplied}
            onClick={resetFilters}
          >
            Reset
          </button>
        </div>
        {hasApplied ? (
          <Banner tone="info">
            <p>
              Filtered
              {applied.patient ? ` · patient: ${labelFor(patients, applied.patient)}` : ''}
              {applied.payoutStatus ? ` · status: ${labelFor(COMMISSION_PAYOUT_STATUSES, applied.payoutStatus)}` : ''}
              {applied.from ? ` · from ${formatDate(applied.from)}` : ''}
              {applied.to ? ` · to ${formatDate(applied.to)}` : ''}.
            </p>
          </Banner>
        ) : null}
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="portal-stack">
          <Table
            columns={columns}
            rows={rows}
            empty={
              pendingOnly
                ? 'No pending commissions.'
                : hasApplied
                  ? 'No commissions match these filters.'
                  : 'No commissions yet.'
            }
          />
          <Pagination
            page={data?.page || 1}
            totalPages={data?.totalPages || 1}
            total={data?.total || 0}
            loading={loading}
            onPage={setPage}
          />
        </div>
      )}
    </SectionShell>
  )
}

// ── Payouts ──────────────────────────────────────────────────────────────────

function Field({ label, children, mono }) {
  return (
    <div className="portal-field-block">
      <span className="portal-field-block__label">{label}</span>
      <div className={mono ? 'portal-field-block__value portal-field-block__value--mono' : 'portal-field-block__value'}>
        {children}
      </div>
    </div>
  )
}

const BREAKDOWN_COLUMNS = [
  { key: 'orderName', label: 'Order ID', width: '15%', render: (r) => <span className="portal-strong">{r.orderName || '—'}</span> },
  { key: 'orderDate', label: 'Order date', width: '14%', render: (r) => formatDate(r.orderDate) },
  { key: 'customerName', label: 'Patient', width: '19%', render: (r) => r.customerName || '—' },
  { key: 'revenue', label: 'Revenue', width: '14%', align: 'right', render: (r) => formatMoney(r.revenue) },
  { key: 'rate', label: 'Commission %', width: '13%', align: 'right', render: (r) => formatPercent(r.rate) },
  { key: 'amount', label: 'Commission', width: '13%', align: 'right', render: (r) => <span className="portal-strong">{formatMoney(r.amount)}</span> },
  { key: 'status', label: 'Status', width: '12%', render: (r) => <StatusBadge value={r.status} /> },
]

function PayoutCard({ payout }) {
  const lines = payout.breakdown || []
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="portal-card">
      <div className="portal-stack">
        <div className="portal-payout-grid">
          <Field label="Date">{formatDate(payout.date)}</Field>
          <Field label="Amount">
            <span className="portal-strong">{formatMoney(payout.amount, payout.currency)}</span>
          </Field>
          <Field label="Method">{titleCase(payout.method)}</Field>
          <Field label="Status">
            <StatusBadge value={payout.status} />
          </Field>
          <Field label="Reference" mono>{payout.reference || '—'}</Field>
          <Field label="Transaction" mono>{payout.transactionId || '—'}</Field>
        </div>

        {lines.length > 0 ? (
          <details open={expanded} onToggle={(e) => setExpanded(e.target.open)}>
            <summary>
              Commission breakdown — {lines.length} order{lines.length === 1 ? '' : 's'}
            </summary>
            <div className="portal-details-body">
              <Table columns={BREAKDOWN_COLUMNS} rows={lines} empty="No commission lines recorded for this payout." />
            </div>
          </details>
        ) : (
          <p className="portal-muted">No commission lines recorded for this payout.</p>
        )}
      </div>
    </div>
  )
}

const EMPTY_PAYOUT_FILTERS = { status: '', from: '', to: '' }

export function PayoutsSection({ onAuthError }) {
  const [draft, setDraft] = useState(EMPTY_PAYOUT_FILTERS)
  const [applied, setApplied] = useState(EMPTY_PAYOUT_FILTERS)
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'payouts',
    { status: applied.status || undefined, from: applied.from, to: applied.to, page, pageSize: 10 },
    onAuthError,
  )

  const rows = data?.rows || []

  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.target.value }))
  const draftMatchesApplied =
    draft.status === applied.status && draft.from === applied.from && draft.to === applied.to
  const hasDraft = !!(draft.status || draft.from || draft.to)
  const hasApplied = !!(applied.status || applied.from || applied.to)

  const applyFilters = () => {
    setApplied({ ...draft })
    setPage(1)
  }
  const resetFilters = () => {
    setDraft(EMPTY_PAYOUT_FILTERS)
    setApplied(EMPTY_PAYOUT_FILTERS)
    setPage(1)
  }

  return (
    <SectionShell heading="Payout history" description="Commission payouts sent to you. Expand a payout to see the order commissions it covers.">
      <div className="portal-stack">
        <div className="portal-field-grid portal-field-grid--3">
          <label className="portal-field">
            <span>Status</span>
            <select value={draft.status} onChange={setField('status')}>
              <option value="">All statuses</option>
              {PAYOUT_STATUSES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="portal-field">
            <span>From</span>
            <input type="date" value={draft.from} onChange={setField('from')} />
          </label>
          <label className="portal-field">
            <span>To</span>
            <input type="date" value={draft.to} onChange={setField('to')} />
          </label>
        </div>
        <div className="portal-inline">
          <button
            type="button"
            className="portal-btn portal-btn--primary"
            disabled={draftMatchesApplied || loading}
            onClick={applyFilters}
          >
            Apply
          </button>
          <button
            type="button"
            className="portal-btn portal-btn--secondary"
            disabled={!hasDraft && !hasApplied}
            onClick={resetFilters}
          >
            Reset
          </button>
        </div>
        {hasApplied ? (
          <Banner tone="info">
            <p>
              Filtered
              {applied.status ? ` · status: ${labelFor(PAYOUT_STATUSES, applied.status)}` : ''}
              {applied.from ? ` · from ${formatDate(applied.from)}` : ''}
              {applied.to ? ` · to ${formatDate(applied.to)}` : ''}.
            </p>
          </Banner>
        ) : null}
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="portal-empty">{hasApplied ? 'No payouts match these filters.' : 'No payouts yet.'}</div>
      ) : (
        <div className="portal-stack">
          {rows.map((p) => (
            <PayoutCard key={p.id} payout={p} />
          ))}
          <Pagination
            page={data?.page || 1}
            totalPages={data?.totalPages || 1}
            total={data?.total || 0}
            loading={loading}
            onPage={setPage}
          />
        </div>
      )}
    </SectionShell>
  )
}

// Copy-to-clipboard button for a referral URL — plain browser DOM has
// navigator.clipboard, unlike the Customer Account Web Worker sandbox this
// was ported from (which needed Polaris's declarative s-clipboard-item).
function CopyUrlButton({ url }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable/denied — no-op, the link is still visible/selectable.
    }
  }
  return (
    <button type="button" className="portal-btn portal-btn--secondary" onClick={handleCopy}>
      {copied ? 'Copied' : 'Copy URL'}
    </button>
  )
}

// ── Referral codes ───────────────────────────────────────────────────────────
export function ReferralsSection({ onAuthError }) {
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'referrals',
    { page, pageSize: 10 },
    onAuthError,
  )
  const rows = data?.rows || []

  const dialogRef = useRef(null)
  const [code, setCode] = useState('')
  const [percent, setPercent] = useState('20')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState(null)

  const usedActiveTiers = new Set(data?.usedActivePercents || [])
  const availablePercents = DISCOUNT_PERCENTS.filter((p) => !usedActiveTiers.has(p))
  const canCreate = availablePercents.length > 0

  const handleApiError = (err, fallback) => {
    if (err instanceof ApiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
      onAuthError?.(err)
      return
    }
    setFormError(err?.message || fallback)
  }

  const resetForm = () => {
    setCode('')
    setPercent('')
    setFormError('')
  }

  const openModal = () => {
    resetForm()
    dialogRef.current?.showModal?.()
  }
  const closeModal = () => dialogRef.current?.close?.()

  const handleCreate = async () => {
    setFormError('')
    setNotice('')
    const trimmed = code.trim()
    if (!trimmed) {
      setFormError('Enter a referral code.')
      return
    }
    if (!percent) {
      setFormError('Choose a discount percentage.')
      return
    }
    setSubmitting(true)
    try {
      await apiPost('referrals', {
        op: 'create',
        code: trimmed,
        discountPercent: Number(percent),
      })
      setNotice(`Referral code "${trimmed.toLowerCase()}" created.`)
      resetForm()
      closeModal()
      reload()
    } catch (err) {
      handleApiError(err, 'Could not create the referral code.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggle = async (row) => {
    setFormError('')
    setNotice('')
    const op = row.status === 'active' ? 'pause' : 'resume'
    setBusyId(row.id)
    try {
      await apiPost('referrals', { op, codeId: row.id })
      setNotice(op === 'pause' ? `Paused "${row.code}".` : `Resumed "${row.code}".`)
      reload()
    } catch (err) {
      handleApiError(err, 'Could not update the referral code.')
    } finally {
      setBusyId(null)
    }
  }

  const columns = [
    { key: 'code', label: 'Code', width: '11%', render: (r) => <span className="portal-strong">{r.code}</span> },
    { key: 'status', label: 'Status', width: '10%', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'discountPercent', label: 'Discount', width: '9%', align: 'right', render: (r) => formatPercent(r.discountPercent) },
    { key: 'referrals', label: 'Referrals', width: '9%', align: 'right', render: (r) => formatNumber(r.referrals) },
    { key: 'orders', label: 'Orders', width: '8%', align: 'right', render: (r) => formatNumber(r.orders) },
    { key: 'revenue', label: 'Revenue', width: '13%', align: 'right', render: (r) => formatMoney(r.revenue) },
    { key: 'commission', label: 'Commission', width: '13%', align: 'right', render: (r) => <span className="portal-strong">{formatMoney(r.commission)}</span> },
    {
      key: 'referralUrl',
      label: 'Referral URL',
      width: '16%',
      render: (r) =>
        r.referralUrl ? (
          <CopyUrlButton url={r.referralUrl} />
        ) : (
          <span className="portal-muted">Not generated yet</span>
        ),
    },
    {
      key: 'actions',
      label: '',
      width: '11%',
      render: (r) =>
        r.status === 'archived' ? (
          <span className="portal-muted">—</span>
        ) : (
          <button
            type="button"
            className="portal-btn portal-btn--secondary"
            disabled={busyId === r.id}
            onClick={() => handleToggle(r)}
          >
            {r.status === 'active' ? 'Pause' : 'Resume'}
          </button>
        ),
    },
  ]

  return (
    <SectionShell heading="Referral management" description="Create, share, and manage your referral codes.">
      <div className="portal-stack">
        <div className="portal-inline portal-inline--end">
          {!canCreate ? (
            <span className="portal-muted">
              You have an active code for every discount tier — pause one to free a tier.
            </span>
          ) : null}
          <button type="button" className="portal-btn portal-btn--primary" disabled={!canCreate} onClick={openModal}>
            Create referral code
          </button>
        </div>
        {notice ? (
          <Banner tone="info">
            <p>{notice}</p>
          </Banner>
        ) : null}
      </div>

      <dialog ref={dialogRef} className="portal-dialog">
        <h3 className="portal-subheading">Create a referral code</h3>
        <div className="portal-stack">
          <p className="portal-muted">
            Choose a code and a discount — we generate the shareable link automatically.
            Codes are unique store-wide; lowercase letters, numbers, "-" or "_".
          </p>

          {formError ? <ErrorBanner message={formError} /> : null}

          {canCreate ? (
            <div className="portal-stack">
              <label className="portal-field">
                <span>Referral code</span>
                <input
                  type="text"
                  placeholder="e.g. jane_clinic"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <label className="portal-field">
                <span>Discount</span>
                <select value={percent} onChange={(e) => setPercent(e.target.value)}>
                  <option value="">Select…</option>
                  {availablePercents.map((p) => (
                    <option key={p} value={String(p)}>
                      {p}%
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="portal-muted">All discount tiers are in use by active codes. Pause one to free a tier.</p>
          )}
        </div>

        <div className="portal-inline portal-inline--end portal-dialog__actions">
          <button type="button" className="portal-btn portal-btn--secondary" onClick={closeModal}>
            Cancel
          </button>
          <button
            type="button"
            className="portal-btn portal-btn--primary"
            onClick={handleCreate}
            disabled={submitting || !canCreate || !code.trim() || !percent}
          >
            {submitting ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </dialog>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="portal-stack">
          <Table columns={columns} rows={rows} empty="No referral codes yet — create one above." />
          <Pagination
            page={data?.page || 1}
            totalPages={data?.totalPages || 1}
            total={data?.total || 0}
            loading={loading}
            onPage={setPage}
          />
        </div>
      )}
    </SectionShell>
  )
}
