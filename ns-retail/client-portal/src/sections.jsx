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
import { apiGet } from './services/ApiService.jsx'
import { formatMoney, formatDate, formatPercent, formatNumber } from './format.js'

// Opens the order's real QBO-rendered invoice PDF directly in the browser
// (never a redirect to QBO's hosted portal). The window must be opened
// SYNCHRONOUSLY in the click handler (user gesture) to survive popup
// blockers — the server returns the PDF base64, which we then swap in as
// a blob URL. Mirrors the admin "Preview invoice" pattern.
async function openInvoicePdf(orderId) {
  const win = window.open('about:blank', '_blank')
  try {
    const result = await apiGet('invoice-pdf', { id: orderId })
    if (!result?.base64) {
      if (win && !win.closed) win.close()
      return { ok: false, message: 'The invoice isn’t ready yet for this order.' }
    }
    const binary = atob(result.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: result.contentType || 'application/pdf' })
    const blobUrl = URL.createObjectURL(blob)
    if (win && !win.closed) {
      win.location.href = blobUrl
    } else {
      // Popup blocked — fall back to a download.
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = result.filename || 'invoice.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    return { ok: true }
  } catch (err) {
    if (win && !win.closed) win.close()
    return { ok: false, message: err?.message || 'Could not load the invoice right now.' }
  }
}

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
const RECENT_ORDERS_COLUMNS = [
  { key: 'orderName', label: 'Order', width: '22%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
  { key: 'placedAt', label: 'Date', width: '22%', render: (r) => formatDate(r.placedAt) },
  { key: 'amount', label: 'Amount', width: '18%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
  { key: 'financialStatus', label: 'Payment', width: '18%', render: (r) => <StatusBadge value={r.financialStatus} /> },
  { key: 'fulfillmentStatus', label: 'Fulfillment', width: '20%', render: (r) => <StatusBadge value={r.shippingStatus || r.fulfillmentStatus} /> },
]

export function DashboardSection({ onAuthError, onViewOrders }) {
  const [selectedOrderId, setSelectedOrderId] = useState(null)
  const { data, loading, error, reload } = useResource('dashboard', null, onAuthError)

  if (selectedOrderId) {
    return (
      <OrderDetailSection
        orderId={selectedOrderId}
        onAuthError={onAuthError}
        onBack={() => setSelectedOrderId(null)}
      />
    )
  }

  if (loading && !data) return <Loading />
  if (error) return <ErrorBanner message={error} onRetry={reload} />

  const d = data || {}

  return (
    <SectionShell heading="Dashboard" description="Your account, at a glance.">
      <StatCards
        cards={[
          { label: 'Total orders', value: formatNumber(d.orderCount), tone: 'blue' },
          { label: 'Orders this month', value: formatNumber(d.ordersThisMonth), tone: 'blue' },
          { label: 'Fulfilled', value: `${formatNumber(d.fulfilledCount)}/${formatNumber(d.orderCount)}`, tone: 'green' },
          { label: 'Cancelled orders', value: formatNumber(d.cancelledCount), tone: d.cancelledCount > 0 ? 'amber' : 'neutral' },
          { label: 'Lifetime spend', value: formatMoney(d.lifetimeSpend, d.currency), tone: 'green' },
          { label: 'This month', value: formatMoney(d.thisMonthSpend, d.currency), tone: 'green' },
          { label: 'Average order', value: formatMoney(d.averageOrderValue, d.currency), tone: 'purple' },
          { label: 'Pending payments', value: formatNumber(d.pendingCount), tone: d.pendingCount > 0 ? 'amber' : 'neutral' },
          { label: 'First order', value: formatDate(d.firstOrderAt), tone: 'neutral' },
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
        <div className="cp-stack">
          <div className="cp-inline cp-inline--between">
            <h3 className="cp-subheading">Recent orders</h3>
            <button type="button" className="cp-btn cp-btn--secondary" onClick={onViewOrders}>
              View all orders
            </button>
          </div>
          <Table
            columns={RECENT_ORDERS_COLUMNS}
            rows={d.recentOrders || []}
            empty="No orders yet."
            onRowClick={(r) => setSelectedOrderId(r.id)}
          />
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
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState('')

  const handleViewInvoice = async () => {
    setPdfError('')
    setPdfBusy(true)
    const result = await openInvoicePdf(orderId)
    setPdfBusy(false)
    if (!result.ok) setPdfError(result.message)
  }

  return (
    <SectionShell heading="Order detail">
      <div className="cp-inline cp-inline--between">
        <button type="button" className="cp-btn cp-btn--secondary" onClick={onBack}>
          ← Back to orders
        </button>
        {data?.hasInvoice ? (
          <button type="button" className="cp-btn cp-btn--primary" disabled={pdfBusy} onClick={handleViewInvoice}>
            {pdfBusy ? 'Loading…' : `View invoice${data.docNumber ? ` ${data.docNumber}` : ''}`}
          </button>
        ) : null}
      </div>

      {pdfError ? <ErrorBanner message={pdfError} /> : null}

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
            <Field label="Invoice">
              {data.invoiceStatus ? <StatusBadge value={data.invoiceStatus} /> : <span className="cp-muted">Processing</span>}
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

const EMPTY_ORDER_FILTERS = { financialStatus: '', fulfillmentStatus: '', search: '', dateFrom: '', dateTo: '' }

export function OrdersSection({ onAuthError, initialOrderId, onOrderIdConsumed }) {
  const [selectedOrderId, setSelectedOrderId] = useState(initialOrderId || null)
  const [draft, setDraft] = useState(EMPTY_ORDER_FILTERS)
  const [applied, setApplied] = useState(EMPTY_ORDER_FILTERS)
  const [page, setPage] = useState(1)
  const [pdfBusyId, setPdfBusyId] = useState(null)
  const [pdfError, setPdfError] = useState('')
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
  const summary = data?.summary || {}
  const setField = (k) => (e) => setDraft((p) => ({ ...p, [k]: e.target.value }))
  const FILTER_KEYS = ['financialStatus', 'fulfillmentStatus', 'search', 'dateFrom', 'dateTo']
  const draftMatchesApplied = FILTER_KEYS.every((k) => draft[k] === applied[k])
  const hasDraft = FILTER_KEYS.some((k) => draft[k])
  const hasApplied = FILTER_KEYS.some((k) => applied[k])

  const applyFilters = () => {
    setApplied({ ...draft })
    setPage(1)
  }
  const resetFilters = () => {
    setDraft(EMPTY_ORDER_FILTERS)
    setApplied(EMPTY_ORDER_FILTERS)
    setPage(1)
  }

  const handleViewInvoice = async (orderId) => {
    setPdfError('')
    setPdfBusyId(orderId)
    const result = await openInvoicePdf(orderId)
    setPdfBusyId(null)
    if (!result.ok) setPdfError(result.message)
  }

  const columns = [
    { key: 'orderName', label: 'Order', width: '15%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
    { key: 'placedAt', label: 'Date', width: '14%', render: (r) => formatDate(r.placedAt) },
    { key: 'amount', label: 'Amount', width: '13%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
    { key: 'financialStatus', label: 'Payment', width: '14%', render: (r) => <StatusBadge value={r.financialStatus} /> },
    { key: 'fulfillmentStatus', label: 'Fulfillment', width: '15%', render: (r) => <StatusBadge value={r.shippingStatus || r.fulfillmentStatus} /> },
    {
      key: 'invoice',
      label: '',
      width: '19%',
      render: (r) =>
        r.hasInvoice ? (
          <button
            type="button"
            className="cp-btn cp-btn--secondary"
            disabled={pdfBusyId === r.id}
            onClick={(e) => {
              e.stopPropagation()
              handleViewInvoice(r.id)
            }}
          >
            {pdfBusyId === r.id ? 'Loading…' : `View invoice${r.docNumber ? ` ${r.docNumber}` : ''}`}
          </button>
        ) : (
          <span className="cp-muted">—</span>
        ),
    },
  ]

  return (
    <SectionShell heading="Orders" description="Your current and past orders. Click a row to see full details.">
      <StatCards
        cards={[
          { label: 'Total orders', value: formatNumber(summary.totalOrders), tone: 'blue' },
          { label: 'Total spend', value: formatMoney(summary.totalSpend, summary.currency), tone: 'neutral' },
          { label: 'Fulfilled', value: `${formatNumber(summary.fulfilledCount)}/${formatNumber(summary.totalOrders)}`, tone: 'green' },
          { label: 'Cancelled orders', value: formatNumber(summary.cancelledCount), tone: summary.cancelledCount > 0 ? 'amber' : 'neutral' },
        ]}
      />

      {pdfError ? <ErrorBanner message={pdfError} /> : null}

      <div className="cp-stack">
        <div className="cp-field-grid cp-field-grid--2">
          <label className="cp-field">
            <span>Search order #</span>
            <input
              type="text"
              placeholder="e.g. 1420"
              value={draft.search}
              onChange={setField('search')}
            />
          </label>
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
          <label className="cp-field">
            <span>From date</span>
            <input type="date" value={draft.dateFrom} onChange={setField('dateFrom')} />
          </label>
          <label className="cp-field">
            <span>To date</span>
            <input type="date" value={draft.dateTo} onChange={setField('dateTo')} />
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

// ── CDO (referral / discount) ────────────────────────────────────────────────
// A single order can carry more than one CDO code (e.g. right after a
// practitioner switch) — `codes[]` lists every matched code on that order,
// so both "Code used" and "Discount %" render one line per code rather
// than assuming a single flat rate.
const USAGE_COLUMNS = [
  { key: 'orderName', label: 'Order', width: '18%', render: (r) => <span className="cp-strong">{r.orderName}</span> },
  { key: 'placedAt', label: 'Date', width: '16%', render: (r) => formatDate(r.placedAt) },
  {
    key: 'codes',
    label: 'Code used',
    width: '18%',
    render: (r) => (r.codes || []).map((c) => c.code).join(', ') || '—',
  },
  {
    key: 'discountPercent',
    label: 'Discount %',
    width: '14%',
    align: 'right',
    render: (r) => (r.codes || []).map((c) => formatPercent(c.discountPercent)).join(', ') || '—',
  },
  {
    key: 'amountSaved',
    label: 'Amount saved',
    width: '16%',
    align: 'right',
    render: (r) => <span className="cp-strong">{formatMoney(r.amountSaved, r.currency)}</span>,
  },
  { key: 'amount', label: 'Order total', width: '18%', align: 'right', render: (r) => formatMoney(r.amount, r.currency) },
]

export function CdoSection({ onAuthError }) {
  const { data, loading, error, reload } = useResource('cdo', null, onAuthError)

  if (loading && !data) return <Loading />
  if (error) return <ErrorBanner message={error} onRetry={reload} />

  const d = data || {}
  if (!d.attributed) return null // shouldn't render — the shell hides this tab for unattributed customers

  const a = d.analytics || {}

  return (
    <SectionShell heading="Customer Discount Offer" description="Your active practitioner discount and usage history.">
      <div className="cp-payout-grid">
        <Field label="Practitioner">{d.practitionerName || '—'}</Field>
        <Field label="Active discount code">
          <span className="cp-strong">{d.code}</span>
        </Field>
        <Field label="Current discount">
          <span className="cp-strong">{formatPercent(d.discountPercent)}</span>
        </Field>
        <Field label="Enrolled since">{formatDate(d.linkedAt)}</Field>
      </div>

      {d.priorCodes && d.priorCodes.length > 0 ? (
        <Banner tone="info">
          <p>
            You&rsquo;ve also previously used {formatNumber(d.priorCodes.length)} earlier code
            {d.priorCodes.length === 1 ? '' : 's'} — <strong>{d.priorCodes.map((c) => c.code).join(', ')}</strong>.
            The benefits and usage history below include savings from all of your codes, past and current.
          </p>
        </Banner>
      ) : null}

      <div>
        <h3 className="cp-subheading">Your benefits</h3>
        <p className="cp-muted">What your CDO discount(s) have actually saved you, lifetime.</p>
        <StatCards
          cards={[
            { label: 'Total saved', value: formatMoney(a.totalSaved, a.currency), tone: 'green' },
            { label: 'Orders discounted', value: formatNumber(a.totalOrders), tone: 'blue' },
            { label: 'Average savings / order', value: formatMoney(a.averageSavingsPerOrder, a.currency), tone: 'purple' },
            { label: 'You paid', value: formatMoney(a.totalSpend, a.currency), tone: 'neutral' },
          ]}
        />
        {a.totalOrders > 0 ? (
          <Banner tone="info">
            <p>
              Without your practitioner discount{d.priorCodes?.length ? 's' : ''}, those {formatNumber(a.totalOrders)} order
              {a.totalOrders === 1 ? '' : 's'} would have cost{' '}
              <strong>{formatMoney(a.totalWithoutDiscount, a.currency)}</strong> — you saved{' '}
              <strong>{formatMoney(a.totalSaved, a.currency)}</strong> in total.
            </p>
          </Banner>
        ) : null}
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
        <Field label="Phone">{d.phone || '—'}</Field>
        <Field label="Enrollment">{d.attributed ? <StatusBadge value="active" /> : <span className="cp-muted">Not enrolled</span>}</Field>
        <Field label="Member since">{formatDate(d.memberSince)}</Field>
        <Field label="Total orders">{formatNumber(d.orderCount)}</Field>
        <Field label="Lifetime spend">{formatMoney(d.lifetimeSpend, d.currency)}</Field>
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

