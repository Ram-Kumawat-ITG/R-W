import { useState, useRef } from 'preact/hooks'
import {
  useResource,
  useDebounced,
  Loading,
  ErrorBanner,
  StatusBadge,
  StatCards,
  Table,
  Pagination,
} from './ui.jsx'
import { apiPost, ApiError } from '../../services/FullPageApi.jsx'
import {
  formatMoney,
  formatDate,
  formatPercent,
  formatNumber,
  titleCase,
  payoutReasonMessage,
} from './format.js'

// Discount tiers offered when a practitioner creates a code. Kept in sync with
// the backend's PORTAL_DISCOUNT_PERCENTS (extensions can't import server
// modules) — update both if this list changes.
const DISCOUNT_PERCENTS = [10, 15, 20, 25, 30, 35]

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
    <s-section heading={heading}>
      {description ? <s-text color="subdued">{description}</s-text> : null}
      <s-stack direction="block" gap="large">
        {children}
      </s-stack>
    </s-section>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
export function OverviewSection({ onAuthError }) {
  // `draft` = what's typed in the date inputs; `applied` = what the revenue
  // query actually uses. Keeping them separate makes the filter explicit — it
  // only runs on Apply, and Reset clears both — so "how do I apply / reset?" is
  // answered by the buttons rather than a silent on-type refetch.
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
    <SectionShell heading="Overview" description="Your referral program at a glance.">
      <StatCards
        cards={[
          { label: 'Referred patients', value: formatNumber(s.referredPatients), sub: 'Unique patients you referred' },
          {
            label: 'Lifetime revenue',
            value: formatMoney(s.lifetimeRevenue),
            sub: lifetimeOrders ? `From ${formatNumber(lifetimeOrders)} referred orders` : 'From referred orders',
          },
          { label: 'Total commission', value: formatMoney(s.totalCommission), sub: 'Earned to date (excludes reversed)' },
          { label: 'Paid commission', value: formatMoney(s.paidCommission), sub: 'Already paid out to you' },
          { label: 'Awaiting payout', value: formatMoney(s.awaitingPayoutCommission), sub: 'Approved — due in an upcoming payout' },
          { label: 'Pending commission', value: formatMoney(s.pendingCommission), sub: 'Accrued — awaiting approval' },
          { label: 'Active referral codes', value: formatNumber(s.activeReferralCodes), sub: 'Currently shareable' },
          { label: 'Revenue this month', value: formatMoney(s.revenueThisMonth), sub: 'Referred orders this month' },
        ]}
      />

      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-300">
          <s-heading>Revenue breakdown</s-heading>
          <s-text color="subdued">
            Revenue from your referred orders. Pick a From and/or To date and choose
            Apply to see a custom range; Reset clears the filter.
          </s-text>
        </s-stack>

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-date-field
            label="From"
            value={draft.from}
            onChange={(e) => setDraft((p) => ({ ...p, from: e.currentTarget.value }))}
          />
          <s-date-field
            label="To"
            value={draft.to}
            onChange={(e) => setDraft((p) => ({ ...p, to: e.currentTarget.value }))}
          />
        </s-grid>

        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button
            variant="primary"
            disabled={!hasDraft || draftMatchesApplied || revenue.loading}
            onClick={applyRange}
          >
            Apply
          </s-button>
          <s-button
            variant="secondary"
            disabled={!hasDraft && !hasApplied}
            onClick={resetRange}
          >
            Reset
          </s-button>
        </s-stack>

        {hasApplied ? (
          <s-banner tone="info">
            <s-text>
              Showing revenue for {applied.from ? formatDate(applied.from) : 'the beginning'} →{' '}
              {applied.to ? formatDate(applied.to) : 'today'}.
            </s-text>
          </s-banner>
        ) : null}

        {revenue.error ? (
          <ErrorBanner message={revenue.error} onRetry={revenue.reload} />
        ) : (
          <StatCards
            cards={[
              { label: 'This month', value: formatMoney(r.thisMonth) },
              { label: 'Last month', value: formatMoney(r.lastMonth) },
              { label: 'Current year', value: formatMoney(r.thisYear) },
              { label: 'Lifetime', value: formatMoney(r.lifetime) },
              ...(r.range !== null && r.range !== undefined
                ? [
                    {
                      label: 'Selected range',
                      value: formatMoney(r.range),
                      sub: `${applied.from ? formatDate(applied.from) : '…'} → ${
                        applied.to ? formatDate(applied.to) : '…'
                      }${r.rangeOrderCount != null ? ` · ${formatNumber(r.rangeOrderCount)} orders` : ''}`,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </s-stack>
    </SectionShell>
  )
}

// Expandable panel shown beneath a patient row: their referral-code history,
// newest first ("Latest" tagged, with the date each code was used). `row.codes`
// arrives already deduped + ordered newest→oldest from the backend. Returns null
// when the patient has no codes (so that row isn't made expandable).
function CodeHistory({ row }) {
  const codes = row.codes || []
  if (codes.length === 0) return null
  return (
    <s-stack direction="block" gap="small-300">
      <s-text type="strong" color="subdued">
        Referral code history
      </s-text>
      {codes.map((c, i) => (
        <s-stack key={`${c.code}-${i}`} direction="inline" gap="small-300" alignItems="center">
          <s-text type={i === 0 ? 'strong' : 'generic'}>{c.code}</s-text>
          {i === 0 ? <s-badge tone="neutral">Latest</s-badge> : null}
          {c.usedAt ? <s-text color="subdued">{formatDate(c.usedAt)}</s-text> : null}
        </s-stack>
      ))}
    </s-stack>
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
    { key: 'name', label: 'Name', render: (r) => <s-text>{r.name || '—'}</s-text> },
    { key: 'email', label: 'Email', render: (r) => <s-text>{r.email || '—'}</s-text> },
    { key: 'referralCode', label: 'Code', render: (r) => <s-text>{r.referralCode || '—'}</s-text> },
    { key: 'registeredAt', label: 'Registered', render: (r) => <s-text>{formatDate(r.registeredAt)}</s-text> },
    { key: 'totalOrders', label: 'Orders', render: (r) => <s-text>{formatNumber(r.totalOrders)}</s-text> },
    { key: 'lifetimeValue', label: 'LTV', render: (r) => <s-text>{formatMoney(r.lifetimeValue)}</s-text> },
  ]

  return (
    <SectionShell heading="Referred customers" description="Patients you have referred.">
      <s-text-field
        label="Search"
        placeholder="Search name or email"
        value={search}
        onInput={(e) => {
          setSearch(e.target.value)
          setPage(1)
        }}
      />
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <s-stack direction="block" gap="base">
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
        </s-stack>
      )}
    </SectionShell>
  )
}

// ── Commissions (all + pending) ──────────────────────────────────────────────
const EMPTY_COMMISSION_FILTERS = { patient: '', payoutStatus: '', from: '', to: '' }

export function CommissionsSection({ mode = 'all', onAuthError }) {
  const pendingOnly = mode === 'pending'
  // draft = the filter inputs; applied = what the query uses. Filtering only
  // runs on Apply; Reset clears both — so the controls are explicit.
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

  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.currentTarget.value }))
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
    { key: 'orderName', label: 'Order', render: (r) => <s-text>{r.orderName || '—'}</s-text> },
    {
      key: 'amount',
      label: pendingOnly ? 'Expected' : 'Amount',
      render: (r) => <s-text type="strong">{formatMoney(r.amount)}</s-text>,
    },
    { key: 'rate', label: 'Rate', render: (r) => <s-text>{formatPercent(r.rate)}</s-text> },
    {
      key: 'payoutStatus',
      label: 'Payout status',
      render: (r) => (
        <s-stack direction="block" gap="small-500">
          <StatusBadge value={r.payoutStatus || 'pending'} />
          {r.payoutStatus === 'failed' && r.payoutFailureReason ? (
            <s-text color="subdued">{payoutReasonMessage(r.payoutFailureReason)}</s-text>
          ) : null}
        </s-stack>
      ),
    },
    { key: 'earnedAt', label: 'Earned on', render: (r) => <s-text>{formatDate(r.earnedAt)}</s-text> },
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
          { label: 'Total earned', value: formatMoney(totals.total), sub: 'Excludes reversed' },
          { label: 'Paid', value: formatMoney(totals.paid), sub: 'Already paid out to you' },
          { label: 'Awaiting payout', value: formatMoney(totals.awaitingPayout), sub: 'Approved — upcoming payout' },
          { label: 'Pending', value: formatMoney(totals.pending), sub: 'Awaiting approval' },
        ]}
      />

      {/* Filters */}
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-select label="Patient" value={draft.patient} onChange={setField('patient')}>
            <s-option value="">All patients</s-option>
            {patients.map((pt) => (
              <s-option key={pt.value} value={pt.value}>
                {pt.label}
              </s-option>
            ))}
          </s-select>
          <s-select label="Payout status" value={draft.payoutStatus} onChange={setField('payoutStatus')}>
            <s-option value="">All statuses</s-option>
            {COMMISSION_PAYOUT_STATUSES.map((o) => (
              <s-option key={o.value} value={o.value}>
                {o.label}
              </s-option>
            ))}
          </s-select>
          <s-date-field label="From" value={draft.from} onChange={setField('from')} />
          <s-date-field label="To" value={draft.to} onChange={setField('to')} />
        </s-grid>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button variant="primary" disabled={draftMatchesApplied || loading} onClick={applyFilters}>
            Apply
          </s-button>
          <s-button variant="secondary" disabled={!hasDraft && !hasApplied} onClick={resetFilters}>
            Reset
          </s-button>
        </s-stack>
        {hasApplied ? (
          <s-banner tone="info">
            <s-text>
              Filtered
              {applied.patient ? ` · patient: ${labelFor(patients, applied.patient)}` : ''}
              {applied.payoutStatus ? ` · status: ${labelFor(COMMISSION_PAYOUT_STATUSES, applied.payoutStatus)}` : ''}
              {applied.from ? ` · from ${formatDate(applied.from)}` : ''}
              {applied.to ? ` · to ${formatDate(applied.to)}` : ''}.
            </s-text>
          </s-banner>
        ) : null}
      </s-stack>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <s-stack direction="block" gap="base">
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
        </s-stack>
      )}
    </SectionShell>
  )
}

// ── Payouts ──────────────────────────────────────────────────────────────────

// A single key/value cell for the payout summary grid.
function Field({ label, children }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text type="strong" color="subdued">
        {label}
      </s-text>
      {children}
    </s-stack>
  )
}

// Order-level commission breakdown for one payout — the orders whose
// commissions were settled by this payout, so practitioners can reconcile it.
const BREAKDOWN_COLUMNS = [
  { key: 'orderName', label: 'Order ID', render: (r) => <s-text>{r.orderName || '—'}</s-text> },
  { key: 'orderDate', label: 'Order date', render: (r) => <s-text>{formatDate(r.orderDate)}</s-text> },
  { key: 'customerName', label: 'Patient', render: (r) => <s-text>{r.customerName || '—'}</s-text> },
  { key: 'revenue', label: 'Revenue', render: (r) => <s-text>{formatMoney(r.revenue)}</s-text> },
  { key: 'rate', label: 'Commission %', render: (r) => <s-text>{formatPercent(r.rate)}</s-text> },
  { key: 'amount', label: 'Commission', render: (r) => <s-text>{formatMoney(r.amount)}</s-text> },
  { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
]

function PayoutCard({ payout }) {
  const lines = payout.breakdown || []
  return (
    <s-box border="base subdued" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <Field label="Date">
            <s-text>{formatDate(payout.date)}</s-text>
          </Field>
          <Field label="Amount">
            <s-text type="strong">{formatMoney(payout.amount, payout.currency)}</s-text>
          </Field>
          <Field label="Method">
            <s-text>{titleCase(payout.method)}</s-text>
          </Field>
          <Field label="Status">
            <StatusBadge value={payout.status} />
          </Field>
          <Field label="Reference">
            <s-text>{payout.reference || '—'}</s-text>
          </Field>
          <Field label="Transaction">
            <s-text>{payout.transactionId || '—'}</s-text>
          </Field>
        </s-grid>

        {lines.length > 0 ? (
          <s-details>
            <s-summary>
              Commission breakdown — {lines.length} order{lines.length === 1 ? '' : 's'}
            </s-summary>
            <s-box paddingBlockStart="small-300">
              <Table
                columns={BREAKDOWN_COLUMNS}
                rows={lines}
                empty="No commission lines recorded for this payout."
              />
            </s-box>
          </s-details>
        ) : (
          <s-text color="subdued">No commission lines recorded for this payout.</s-text>
        )}
      </s-stack>
    </s-box>
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

  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.currentTarget.value }))
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
      {/* Filters */}
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <s-select label="Status" value={draft.status} onChange={setField('status')}>
            <s-option value="">All statuses</s-option>
            {PAYOUT_STATUSES.map((o) => (
              <s-option key={o.value} value={o.value}>
                {o.label}
              </s-option>
            ))}
          </s-select>
          <s-date-field label="From" value={draft.from} onChange={setField('from')} />
          <s-date-field label="To" value={draft.to} onChange={setField('to')} />
        </s-grid>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-button variant="primary" disabled={draftMatchesApplied || loading} onClick={applyFilters}>
            Apply
          </s-button>
          <s-button variant="secondary" disabled={!hasDraft && !hasApplied} onClick={resetFilters}>
            Reset
          </s-button>
        </s-stack>
        {hasApplied ? (
          <s-banner tone="info">
            <s-text>
              Filtered
              {applied.status ? ` · status: ${labelFor(PAYOUT_STATUSES, applied.status)}` : ''}
              {applied.from ? ` · from ${formatDate(applied.from)}` : ''}
              {applied.to ? ` · to ${formatDate(applied.to)}` : ''}.
            </s-text>
          </s-banner>
        ) : null}
      </s-stack>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 ? (
        <s-text color="subdued">{hasApplied ? 'No payouts match these filters.' : 'No payouts yet.'}</s-text>
      ) : (
        <s-stack direction="block" gap="base">
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
        </s-stack>
      )}
    </SectionShell>
  )
}

// Copy-to-clipboard button for a referral URL. The customer-account Web Worker
// sandbox has no `navigator.clipboard`, but Polaris exposes a declarative
// clipboard: an invisible `s-clipboard-item` holds the text and an invoker
// button copies it via `command="--copy"` + `commandFor` (targeting the item by
// id). `onCopy` briefly flips the label/icon to a "Copied" confirmation.
function CopyUrlButton({ url, id }) {
  const [copied, setCopied] = useState(false)
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      <s-button
        commandFor={id}
        command="--copy"
        variant="secondary"
        icon={copied ? 'clipboard-check' : 'clipboard'}
        accessibilityLabel={copied ? 'Referral URL copied' : 'Copy referral URL'}
      >
        {copied ? 'Copied' : 'Copy URL'}
      </s-button>
      <s-clipboard-item
        id={id}
        text={url}
        onCopy={() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      ></s-clipboard-item>
    </s-stack>
  )
}

// ── Referral codes ───────────────────────────────────────────────────────────
const CREATE_MODAL_ID = 'create-referral-code-modal'

export function ReferralsSection({ onAuthError }) {
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'referrals',
    { page, pageSize: 10 },
    onAuthError,
  )
  const rows = data?.rows || []

  // Create-form state (the form lives inside the modal).
  const modalRef = useRef(null)
  const [code, setCode] = useState('')
  const [percent, setPercent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  // Id of the code whose Pause/Resume is mid-flight (disables just that row).
  const [busyId, setBusyId] = useState(null)

  // Rule A (client-side mirror): a discount tier already used by an ACTIVE code
  // can't be re-used, so drop it from the dropdown. The table is paginated, so
  // this comes from the server's full-set `usedActivePercents` (NOT the current
  // page's rows). Pausing a code frees its tier; the server still enforces this.
  const usedActiveTiers = new Set(data?.usedActivePercents || [])
  const availablePercents = DISCOUNT_PERCENTS.filter((p) => !usedActiveTiers.has(p))
  const canCreate = availablePercents.length > 0

  // Map an ApiError to either the auth-shell switch (401/403) or an inline msg.
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

  // Close the modal programmatically. The s-modal element's method is
  // `hideOverlay()` (BaseOverlayMethods) — NOT `hide()`; the latter silently
  // no-ops, leaving the popup open after a successful create.
  const closeModal = () => modalRef.current?.hideOverlay?.()

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
      setNotice(`Referral code “${trimmed.toLowerCase()}” created.`)
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
      setNotice(op === 'pause' ? `Paused “${row.code}”.` : `Resumed “${row.code}”.`)
      reload()
    } catch (err) {
      handleApiError(err, 'Could not update the referral code.')
    } finally {
      setBusyId(null)
    }
  }

  const columns = [
    {
      key: 'code',
      label: 'Code',
      render: (r) => <s-text type="strong">{r.code}</s-text>,
    },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'discountPercent', label: 'Discount', render: (r) => <s-text>{formatPercent(r.discountPercent)}</s-text> },
    { key: 'referrals', label: 'Referrals', render: (r) => <s-text>{formatNumber(r.referrals)}</s-text> },
    { key: 'orders', label: 'Orders', render: (r) => <s-text>{formatNumber(r.orders)}</s-text> },
    { key: 'revenue', label: 'Revenue', render: (r) => <s-text>{formatMoney(r.revenue)}</s-text> },
    { key: 'commission', label: 'Commission', render: (r) => <s-text>{formatMoney(r.commission)}</s-text> },
    // Shareable referral link — surfaced as a compact "Copy URL" button
    // (replaces the long inline link). Copy uses Polaris's declarative
    // clipboard (see CopyUrlButton); the column no longer needs extra width.
    {
      key: 'referralUrl',
      label: 'Referral URL',
      render: (r) =>
        r.referralUrl ? (
          <CopyUrlButton url={r.referralUrl} id={`copy-${r.id}`} />
        ) : (
          <s-text color="subdued">Not generated yet</s-text>
        ),
    },
    // Pause (active) / Resume (paused). Archived codes can't be toggled.
    {
      key: 'actions',
      label: '',
      render: (r) =>
        r.status === 'archived' ? (
          <s-text color="subdued">—</s-text>
        ) : (
          <s-button disabled={busyId === r.id} onClick={() => handleToggle(r)}>
            {r.status === 'active' ? 'Pause' : 'Resume'}
          </s-button>
        ),
    },
  ]

  return (
    <SectionShell heading="Referral management" description="Create, share, and manage your referral codes.">
      {/* Create-code trigger (right-aligned) + result notice. Form lives in a modal. */}
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
          {!canCreate ? (
            <s-text color="subdued">
              You have an active code for every discount tier — pause one to free a tier.
            </s-text>
          ) : null}
          <s-button
            variant="primary"
            commandFor={CREATE_MODAL_ID}
            command="--show"
            disabled={!canCreate}
            onClick={resetForm}
          >
            Create referral code
          </s-button>
        </s-stack>
        {notice ? (
          <s-banner tone="info" heading="Done">
            <s-text>{notice}</s-text>
          </s-banner>
        ) : null}
      </s-stack>

      {/* Create-code modal — the full creation flow runs from here. */}
      <s-modal id={CREATE_MODAL_ID} ref={modalRef} heading="Create a referral code">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Choose a code and a discount — we generate the shareable link automatically.
            Codes are unique store-wide; lowercase letters, numbers, “-” or “_”.
          </s-text>

          {formError ? <ErrorBanner message={formError} /> : null}

          {canCreate ? (
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Referral code"
                placeholder="e.g. jane_clinic"
                value={code}
                onInput={(e) => setCode(e.target.value)}
              />
              <s-select
                label="Discount"
                value={percent}
                onChange={(e) => setPercent(e.currentTarget.value)}
              >
                <s-option value="">Select…</s-option>
                {availablePercents.map((p) => (
                  <s-option key={p} value={String(p)}>
                    {p}%
                  </s-option>
                ))}
              </s-select>
            </s-stack>
          ) : (
            <s-text color="subdued">
              All discount tiers are in use by active codes. Pause one to free a tier.
            </s-text>
          )}
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          onClick={handleCreate}
          disabled={submitting || !canCreate || !code.trim() || !percent}
        >
          {submitting ? 'Creating…' : 'Create code'}
        </s-button>
        <s-button slot="secondary-actions" commandFor={CREATE_MODAL_ID} command="--hide">
          Cancel
        </s-button>
      </s-modal>

      {/* Existing codes */}
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <s-stack direction="block" gap="base">
          <Table columns={columns} rows={rows} empty="No referral codes yet — create one above." />
          <Pagination
            page={data?.page || 1}
            totalPages={data?.totalPages || 1}
            total={data?.total || 0}
            loading={loading}
            onPage={setPage}
          />
        </s-stack>
      )}
    </SectionShell>
  )
}

// ── Discounts ────────────────────────────────────────────────────────────────
export function DiscountsSection({ onAuthError }) {
  const { data, loading, error, reload } = useResource('discounts', null, onAuthError)
  const rows = data?.rows || []
  const columns = [
    { key: 'code', label: 'Code', render: (r) => <s-text type="strong">{r.code}</s-text> },
    { key: 'type', label: 'Type', render: (r) => <s-text>{r.type}</s-text> },
    { key: 'value', label: 'Value', render: (r) => <s-text>{r.value}%</s-text> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'usageCount', label: 'Usage', render: (r) => <s-text>{formatNumber(r.usageCount)}</s-text> },
    { key: 'expiresAt', label: 'Expires', render: (r) => <s-text>{r.expiresAt ? formatDate(r.expiresAt) : 'No expiry'}</s-text> },
  ]

  return (
    <SectionShell heading="Discounts & promotions" description="Discounts tied to your referral codes.">
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <Table columns={columns} rows={rows} empty="No discounts." />
      )}
    </SectionShell>
  )
}
