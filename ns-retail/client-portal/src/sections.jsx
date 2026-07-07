import { useState } from 'react'
import {
  useResource,
  Loading,
  ErrorBanner,
  Banner,
  StatusBadge,
  StatCards,
  Table,
  Pagination,
} from './ui.jsx'
import { formatMoney, formatDate, formatPercent, formatNumber } from './format.js'

function SectionShell({ heading, description, children }) {
  return (
    <section className="cp-section">
      <h2 className="cp-section__heading">{heading}</h2>
      {description ? <p className="cp-muted">{description}</p> : null}
      <div className="cp-stack">{children}</div>
    </section>
  )
}

function Field({ label, children }) {
  return (
    <div className="cp-field-block">
      <span className="cp-field-block__label">{label}</span>
      <div className="cp-field-block__value">{children}</div>
    </div>
  )
}

function AddressBlock({ address }) {
  if (!address) return <span className="cp-muted">No address on file yet.</span>
  const lines = [address.name, address.line1, address.line2, [address.city, address.province, address.zip].filter(Boolean).join(', '), address.country].filter(Boolean)
  return (
    <div className="cp-stack cp-stack--tight">
      {lines.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </div>
  )
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export function DashboardSection({ onAuthError, onViewOrders }) {
  const { data, loading, error, reload } = useResource('dashboard', null, onAuthError)

  if (loading && !data) return <Loading />
  if (error) return <ErrorBanner message={error} onRetry={reload} />

  const d = data || {}

  return (
    <SectionShell heading="Dashboard" description="Your account, at a glance.">
      <StatCards
        cards={[
          { label: 'Total orders', value: formatNumber(d.orderCount), tone: 'blue' },
          { label: 'Lifetime spend', value: formatMoney(d.lifetimeSpend, d.currency), tone: 'green' },
          { label: 'Last order', value: formatDate(d.lastOrderAt), tone: 'neutral' },
        ]}
      />

      {d.attributed && d.referral ? (
        <Banner tone="info" heading="Linked to a practitioner">
          <p>
            You&rsquo;re currently enrolled with <strong>{d.referral.practitionerName || 'your practitioner'}</strong> —
            see the CDO tab for your discount details.
          </p>
        </Banner>
      ) : null}

      {d.orderCount > 0 ? (
        <div className="cp-inline">
          <button type="button" className="cp-btn cp-btn--secondary" onClick={onViewOrders}>
            View all orders
          </button>
        </div>
      ) : (
        <Banner tone="info">
          <p>You haven&rsquo;t placed any orders yet.</p>
        </Banner>
      )}
    </SectionShell>
  )
}

// ── Order detail ─────────────────────────────────────────────────────────────
const LINE_ITEM_COLUMNS = [
  { key: 'title', label: 'Product', render: (r) => (
    <span className="cp-strong">
      {r.title}
      {r.variantTitle ? <span className="cp-muted"> — {r.variantTitle}</span> : null}
    </span>
  ) },
  { key: 'sku', label: 'SKU', width: '14%', render: (r) => r.sku || '—' },
  { key: 'quantity', label: 'Qty', width: '10%', align: 'right' },
  { key: 'price', label: 'Price', width: '14%', align: 'right', render: (r) => formatMoney(r.price) },
]

export function OrderDetailSection({ orderId, onBack, onAuthError }) {
  const { data, loading, error, reload } = useResource('order', { id: orderId }, onAuthError)

  return (
    <SectionShell heading="Order detail">
      <div className="cp-inline">
        <button type="button" className="cp-btn cp-btn--secondary" onClick={onBack}>
          ← Back to orders
        </button>
      </div>

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : !data ? (
        <Banner tone="critical">
          <p>Order not found.</p>
        </Banner>
      ) : (
        <div className="cp-stack">
          <div className="cp-payout-grid">
            <Field label="Order">{data.orderName}</Field>
            <Field label="Placed">{formatDate(data.placedAt)}</Field>
            <Field label="Amount">
              <span className="cp-strong">{formatMoney(data.amount, data.currency)}</span>
            </Field>
            <Field label="Payment">
              <StatusBadge value={data.financialStatus} />
            </Field>
            <Field label="Fulfillment">
              <StatusBadge value={data.shippingStatus || data.fulfillmentStatus} />
            </Field>
            <Field label="Delivery">
              <StatusBadge value={data.deliveryStatus} />
            </Field>
          </div>

          {data.tracking && data.tracking.length > 0 ? (
            <div className="cp-stack cp-stack--tight">
              <span className="cp-strong cp-muted">Tracking</span>
              {data.tracking.map((t, i) => (
                <div key={i} className="cp-inline cp-inline--tight">
                  <span>{t.company || 'Carrier'}</span>
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer">
                      Track shipment
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div>
            <h3 className="cp-subheading">Line items</h3>
            <Table columns={LINE_ITEM_COLUMNS} rows={data.lineItems || []} empty="No line items." />
          </div>

          <div className="cp-payout-grid">
            <Field label="Subtotal">{formatMoney(data.pricing?.subtotal)}</Field>
            <Field label="Discounts">{formatMoney(data.pricing?.totalDiscounts)}</Field>
            <Field label="Shipping">{formatMoney(data.pricing?.totalShipping)}</Field>
            <Field label="Tax">{formatMoney(data.pricing?.totalTax)}</Field>
            <Field label="Total">
              <span className="cp-strong">{formatMoney(data.pricing?.total ?? data.amount, data.currency)}</span>
            </Field>
          </div>

          <div className="cp-field-grid cp-field-grid--2">
            <div>
              <h3 className="cp-subheading">Billing address</h3>
              <AddressBlock address={data.billingAddress} />
            </div>
            <div>
              <h3 className="cp-subheading">Shipping address</h3>
              <AddressBlock address={data.shippingAddress} />
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  )
}

// ── Orders ───────────────────────────────────────────────────────────────────
const FINANCIAL_STATUSES = [
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'refunded', label: 'Refunded' },
]
const FULFILLMENT_STATUSES = [
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'partial', label: 'Partially fulfilled' },
  { value: 'unfulfilled', label: 'Unfulfilled' },
]

const EMPTY_ORDER_FILTERS = { financialStatus: '', fulfillmentStatus: '' }

export function OrdersSection({ onAuthError, initialOrderId, onOrderIdConsumed }) {
  const [selectedOrderId, setSelectedOrderId] = useState(initialOrderId || null)
  const [draft, setDraft] = useState(EMPTY_ORDER_FILTERS)
  const [applied, setApplied] = useState(EMPTY_ORDER_FILTERS)
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource(
    'orders',
    { ...applied, page, pageSize: 10 },
    onAuthError,
  )

  if (selectedOrderId) {
    return (
      <OrderDetailSection
        orderId={selectedOrderId}
        onAuthError={onAuthError}
        onBack={() => {
          setSelectedOrderId(null)
          onOrderIdConsumed?.()
        }}
      />
    )
  }

  const rows = data?.rows || []
  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.target.value }))
  const draftMatchesApplied = draft.financialStatus === applied.financialStatus && draft.fulfillmentStatus === applied.fulfillmentStatus
  const hasDraft = !!(draft.financialStatus || draft.fulfillmentStatus)
  const hasApplied = !!(applied.financialStatus || applied.fulfillmentStatus)

  const applyFilters = () => {
    setApplied({ ...draft })
    setPage(1)
  }
  const resetFilters = () => {
    setDraft(EMPTY_ORDER_FILTERS)
    setApplied(EMPTY_ORDER_FILTERS)
    setPage(1)
  }

  const columns = [
    { key: 'orderName', label: 'Order', width: '18%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
    { key: 'placedAt', label: 'Date', width: '18%', render: (r) => formatDate(r.placedAt) },
    { key: 'amount', label: 'Amount', width: '16%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
    { key: 'financialStatus', label: 'Payment', width: '18%', render: (r) => <StatusBadge value={r.financialStatus} /> },
    { key: 'fulfillmentStatus', label: 'Fulfillment', width: '18%', render: (r) => <StatusBadge value={r.shippingStatus || r.fulfillmentStatus} /> },
  ]

  return (
    <SectionShell heading="Orders" description="Your current and past orders. Click a row to see full details.">
      <div className="cp-stack">
        <div className="cp-field-grid cp-field-grid--2">
          <label className="cp-field">
            <span>Payment status</span>
            <select value={draft.financialStatus} onChange={setField('financialStatus')}>
              <option value="">Any</option>
              {FINANCIAL_STATUSES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="cp-field">
            <span>Fulfillment status</span>
            <select value={draft.fulfillmentStatus} onChange={setField('fulfillmentStatus')}>
              <option value="">Any</option>
              {FULFILLMENT_STATUSES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="cp-inline">
          <button type="button" className="cp-btn cp-btn--primary" disabled={draftMatchesApplied || loading} onClick={applyFilters}>
            Apply
          </button>
          <button type="button" className="cp-btn cp-btn--secondary" disabled={!hasDraft && !hasApplied} onClick={resetFilters}>
            Reset
          </button>
        </div>
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="cp-stack">
          <Table
            columns={columns}
            rows={rows}
            empty={hasApplied ? 'No orders match these filters.' : 'No orders yet.'}
            onRowClick={(r) => setSelectedOrderId(r.id)}
          />
          <Pagination page={data?.page || 1} totalPages={data?.pageCount || 1} total={data?.total || 0} loading={loading} onPage={setPage} />
        </div>
      )}
    </SectionShell>
  )
}

// ── Payment history ──────────────────────────────────────────────────────────
export function PaymentsSection({ onAuthError }) {
  const [page, setPage] = useState(1)
  const { data, loading, error, reload } = useResource('payments', { page, pageSize: 10 }, onAuthError)
  const rows = data?.rows || []

  const columns = [
    { key: 'orderName', label: 'Order', width: '18%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
    { key: 'placedAt', label: 'Date', width: '16%', render: (r) => formatDate(r.placedAt) },
    { key: 'amount', label: 'Amount', width: '14%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
    { key: 'financialStatus', label: 'Payment', width: '14%', render: (r) => <StatusBadge value={r.financialStatus} /> },
    {
      key: 'invoiceStatus',
      label: 'Invoice',
      width: '20%',
      render: (r) => (r.invoiceStatus ? <StatusBadge value={r.invoiceStatus} /> : <span className="cp-muted">Processing</span>),
    },
    {
      key: 'invoiceUrl',
      label: 'Details',
      width: '18%',
      render: (r) =>
        r.invoiceUrl ? (
          <a href={r.invoiceUrl} target="_blank" rel="noreferrer">
            View invoice{r.docNumber ? ` #${r.docNumber}` : ''}
          </a>
        ) : (
          <span className="cp-muted">—</span>
        ),
    },
  ]

  return (
    <SectionShell heading="Payment history" description="Payment status and invoice details for each of your orders.">
      {error ? (
        <ErrorBanner message={error} onRetry={reload} />
      ) : loading && rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="cp-stack">
          <Table columns={columns} rows={rows} empty="No payment history yet." />
          <Pagination page={data?.page || 1} totalPages={data?.pageCount || 1} total={data?.total || 0} loading={loading} onPage={setPage} />
        </div>
      )}
    </SectionShell>
  )
}

// ── CDO (referral / discount) ────────────────────────────────────────────────
const USAGE_COLUMNS = [
  { key: 'orderName', label: 'Order', width: '25%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
  { key: 'placedAt', label: 'Date', width: '20%', render: (r) => formatDate(r.placedAt) },
  {
    key: 'discountCodes',
    label: 'Code used',
    width: '25%',
    render: (r) => (r.discountCodes || []).map((c) => c.code).join(', ') || '—',
  },
  { key: 'amount', label: 'Order total', width: '20%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
]

export function CdoSection({ onAuthError }) {
  const { data, loading, error, reload } = useResource('cdo', null, onAuthError)

  if (loading && !data) return <Loading />
  if (error) return <ErrorBanner message={error} onRetry={reload} />

  const d = data || {}
  if (!d.attributed) return null // shouldn't render — the shell hides this tab for unattributed customers

  return (
    <SectionShell heading="Customer Discount Offer" description="Your active practitioner discount and usage history.">
      <div className="cp-payout-grid">
        <Field label="Practitioner">{d.practitionerName || '—'}</Field>
        <Field label="Discount code">
          <span className="cp-strong">{d.code}</span>
        </Field>
        <Field label="Discount">
          <span className="cp-strong">{formatPercent(d.discountPercent)}</span>
        </Field>
        <Field label="Enrolled since">{formatDate(d.linkedAt)}</Field>
      </div>

      <div>
        <h3 className="cp-subheading">Usage history</h3>
        <Table columns={USAGE_COLUMNS} rows={d.usage || []} empty="No orders have used this code yet." />
      </div>
    </SectionShell>
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────
export function ProfileSection({ onAuthError }) {
  const { data, loading, error, reload } = useResource('profile', null, onAuthError)

  if (loading && !data) return <Loading />
  if (error) return <ErrorBanner message={error} onRetry={reload} />

  const d = data || {}

  return (
    <SectionShell heading="Profile" description="Your account details.">
      <div className="cp-payout-grid">
        <Field label="Name">{d.name || '—'}</Field>
        <Field label="Email">{d.email || '—'}</Field>
        <Field label="Enrollment">{d.attributed ? <StatusBadge value="active" /> : <span className="cp-muted">Not enrolled</span>}</Field>
      </div>

      {!d.hasOrders ? (
        <Banner tone="info">
          <p>Addresses on file will appear here after your first order.</p>
        </Banner>
      ) : (
        <div className="cp-field-grid cp-field-grid--2">
          <div>
            <h3 className="cp-subheading">Billing address</h3>
            <AddressBlock address={d.billingAddress} />
          </div>
          <div>
            <h3 className="cp-subheading">Shipping address</h3>
            <AddressBlock address={d.shippingAddress} />
          </div>
        </div>
      )}
    </SectionShell>
  )
}

