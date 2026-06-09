import { useState } from 'preact/hooks'
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
import { formatMoney, formatDate, formatPercent, formatNumber, titleCase } from './format.js'

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
  const [range, setRange] = useState({ from: '', to: '' })
  const summary = useResource('summary', null, onAuthError)
  const revenue = useResource('revenue', range, onAuthError)

  if (summary.loading && !summary.data) return <Loading />
  if (summary.error) return <ErrorBanner message={summary.error} onRetry={summary.reload} />

  const s = summary.data || {}
  const r = revenue.data || {}

  return (
    <SectionShell heading="Overview" description="Your referral program at a glance.">
      <StatCards
        cards={[
          { label: 'Referred patients', value: formatNumber(s.referredPatients) },
          { label: 'Lifetime revenue', value: formatMoney(s.lifetimeRevenue), sub: 'From referred orders' },
          { label: 'Total commission', value: formatMoney(s.totalCommission) },
          { label: 'Paid commission', value: formatMoney(s.paidCommission) },
          { label: 'Awaiting payout', value: formatMoney(s.awaitingPayoutCommission) },
          { label: 'Pending commission', value: formatMoney(s.pendingCommission) },
          { label: 'Active referral codes', value: formatNumber(s.activeReferralCodes) },
          { label: 'Revenue this month', value: formatMoney(s.revenueThisMonth) },
        ]}
      />

      <s-stack direction="block" gap="base">
        <s-heading>Revenue breakdown</s-heading>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="From"
            type="date"
            value={range.from}
            onChange={(e) => setRange((p) => ({ ...p, from: e.target.value }))}
          />
          <s-text-field
            label="To"
            type="date"
            value={range.to}
            onChange={(e) => setRange((p) => ({ ...p, to: e.target.value }))}
          />
        </s-grid>
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
                ? [{ label: 'Selected range', value: formatMoney(r.range), sub: `${range.from || '…'} → ${range.to || '…'}` }]
                : []),
            ]}
          />
        )}
      </s-stack>
    </SectionShell>
  )
}

// ── Referred customers ───────────────────────────────────────────────────────
export function PatientsSection({ onAuthError }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const debounced = useDebounced(search)
  const { data, loading, error, reload } = useResource(
    'customers',
    { search: debounced, page, pageSize: 20 },
    onAuthError,
  )

  const rows = data?.rows || []
  const columns = [
    { key: 'name', label: 'Name', render: (r) => <s-text>{r.name || '—'}</s-text> },
    { key: 'email', label: 'Email', render: (r) => <s-text>{r.email || '—'}</s-text> },
    { key: 'referralCode', label: 'Code', render: (r) => <s-text>{r.referralCode || '—'}</s-text> },
    { key: 'registeredAt', label: 'Registered', render: (r) => <s-text>{formatDate(r.registeredAt)}</s-text> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
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
          <Table columns={columns} rows={rows} empty="No referred customers yet." />
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
export function CommissionsSection({ mode = 'all', onAuthError }) {
  const pendingOnly = mode === 'pending'
  const [range, setRange] = useState({ from: '', to: '' })
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'commissions',
    {
      pendingOnly: pendingOnly ? '1' : undefined,
      from: range.from,
      to: range.to,
      page,
      pageSize: 20,
    },
    onAuthError,
  )

  const rows = data?.rows || []
  const totals = data?.totals || {}
  const columns = [
    { key: 'orderName', label: 'Order', render: (r) => <s-text>{r.orderName || '—'}</s-text> },
    { key: 'amount', label: pendingOnly ? 'Expected' : 'Amount', render: (r) => <s-text>{formatMoney(r.amount)}</s-text> },
    { key: 'rate', label: 'Rate', render: (r) => <s-text>{formatPercent(r.rate)}</s-text> },
    {
      key: 'payoutStatus',
      label: 'Payout status',
      render: (r) => <StatusBadge value={r.payoutStatus || 'awaiting'} />,
    },
    { key: 'earnedAt', label: 'Earned on', render: (r) => <s-text>{formatDate(r.earnedAt)}</s-text> },
  ]

  return (
    <SectionShell
      heading={pendingOnly ? 'Pending commissions' : 'Commission summary'}
      description={
        pendingOnly
          ? 'Commissions earned but not yet paid out.'
          : 'All commissions earned from referred orders.'
      }
    >
      <StatCards
        cards={[
          { label: 'Total earned', value: formatMoney(totals.total) },
          { label: 'Paid', value: formatMoney(totals.paid) },
          { label: 'Awaiting payout', value: formatMoney(totals.awaitingPayout) },
          { label: 'Pending', value: formatMoney(totals.pending) },
        ]}
      />
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-text-field
          label="From"
          type="date"
          value={range.from}
          onChange={(e) => {
            setRange((p) => ({ ...p, from: e.target.value }))
            setPage(1)
          }}
        />
        <s-text-field
          label="To"
          type="date"
          value={range.to}
          onChange={(e) => {
            setRange((p) => ({ ...p, to: e.target.value }))
            setPage(1)
          }}
        />
      </s-grid>
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <s-stack direction="block" gap="base">
          <Table
            columns={columns}
            rows={rows}
            empty={pendingOnly ? 'No pending commissions.' : 'No commissions yet.'}
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

export function PayoutsSection({ onAuthError }) {
  const [range, setRange] = useState({ from: '', to: '' })
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'payouts',
    { status, from: range.from, to: range.to, page, pageSize: 20 },
    onAuthError,
  )

  const rows = data?.rows || []

  return (
    <SectionShell heading="Payout history" description="Commission payouts sent to you. Expand a payout to see the order commissions it covers.">
      <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
        <s-select
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.currentTarget.value)
            setPage(1)
          }}
        >
          <s-option value="">All</s-option>
          <s-option value="paid">Paid</s-option>
        </s-select>
        <s-text-field
          label="From"
          type="date"
          value={range.from}
          onChange={(e) => {
            setRange((p) => ({ ...p, from: e.target.value }))
            setPage(1)
          }}
        />
        <s-text-field
          label="To"
          type="date"
          value={range.to}
          onChange={(e) => {
            setRange((p) => ({ ...p, to: e.target.value }))
            setPage(1)
          }}
        />
      </s-grid>
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : rows.length === 0 ? (
        <s-text color="subdued">No payouts yet.</s-text>
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

// ── Referral codes ───────────────────────────────────────────────────────────
export function ReferralsSection({ onAuthError }) {
  const { data, loading, error, reload } = useResource('referrals', null, onAuthError)
  const rows = data?.rows || []
  const columns = [
    {
      key: 'code',
      label: 'Code',
      render: (r) => (
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{r.code}</s-text>
          {r.isPrimary ? <s-badge tone="info">Primary</s-badge> : null}
        </s-stack>
      ),
    },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
    { key: 'discountPercent', label: 'Discount', render: (r) => <s-text>{formatPercent(r.discountPercent)}</s-text> },
    { key: 'referrals', label: 'Referrals', render: (r) => <s-text>{formatNumber(r.referrals)}</s-text> },
    { key: 'orders', label: 'Orders', render: (r) => <s-text>{formatNumber(r.orders)}</s-text> },
    { key: 'revenue', label: 'Revenue', render: (r) => <s-text>{formatMoney(r.revenue)}</s-text> },
    { key: 'commission', label: 'Commission', render: (r) => <s-text>{formatMoney(r.commission)}</s-text> },
  ]

  return (
    <SectionShell heading="Referral management" description="Your codes and how each performs.">
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <Table columns={columns} rows={rows} empty="No referral codes." />
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
