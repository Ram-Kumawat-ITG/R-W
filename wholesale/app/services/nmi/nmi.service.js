// NMI domain methods — Customer Vault find/create, sale charges,
// refund/void admin helpers. All HTTP plumbing is in nmi.apis.js.

import { nmiTransact, nmiQuery } from './nmi.apis'
import {
  classifyNmiResponse,
  // Render-time helpers + XML parsers live in nmi.utils.js so
  // client-side route renders can import them without pulling
  // nmi.config.js (and its `process.env` access) into the browser
  // bundle. nmi.service.js's transitive imports (nmi.apis → nmi.config)
  // have side effects at module init and cannot be tree-shaken; the
  // utils split is the cleanest fix.
  //
  // Only the symbols nmi.service.js USES internally are imported here.
  // Client routes must import the pure helpers (`fromNmiDate`, etc.)
  // straight from `./nmi.utils` — importing them from this file would
  // drag the whole service module into the browser bundle.
  toNmiDate,
  latestAction,
  parseNmiTransactions,
  parseNmiCustomerVaults,
} from './nmi.utils'
import { NMI_SENSITIVE_PARAMS } from './nmi.constants'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('nmi.service')

// ── Customer Vault ───────────────────────────────────────────────────

// Look up an existing Customer Vault entry. NMI doesn't allow query by
// email out of the box on transact.php, so we use query.php which returns
// XML. We do a substring match for the email and pull the first match.
//
// In production, store the `customer_vault_id` against your customer at
// creation time (see CustomerMap.nmiCustomerVaultId) so this lookup is
// only used as a recovery path.
export async function findCustomerVaultByEmail(email) {
  if (!email) return null
  try {
    const xml = await nmiQuery({ report_type: 'customer_vault', email })
    // Cheap structural parse — we only need the id. A full XML parser
    // is overkill and adds a dependency.
    const idMatch = xml.match(/<customer_vault_id>([^<]+)<\/customer_vault_id>/)
    return idMatch ? idMatch[1] : null
  } catch (err) {
    log.warn('vault.lookup.failed', { email, err })
    return null
  }
}

// Confirm a stored vault id still resolves to a real Customer Vault entry
// in NMI. Used as a pre-flight before any sale/charge against a vault id
// that was captured at registration time — protects against the case
// where a vault was deleted out-of-band or the id was corrupted.
//
// Returns `{ valid: boolean, reason?: string }`. Network / transport
// failures resolve to `{ valid: false, reason }` so callers can decide
// whether to retry or skip — they MUST NOT silently proceed to charge.
export async function validateCustomerVault(customerVaultId) {
  if (!customerVaultId) return { valid: false, reason: 'no vault id provided' }
  try {
    const xml = await nmiQuery({
      report_type: 'customer_vault',
      customer_vault_id: customerVaultId,
    })
    // query.php returns a <customer_vault><customer> block on success,
    // or an <error_response>…</error_response> when the id is unknown.
    if (/<error_response>/i.test(xml)) {
      const reason = (xml.match(/<error_response>([^<]+)<\/error_response>/i) || [])[1] || 'vault not found'
      log.warn('vault.validate.not_found', { customerVaultId, reason })
      return { valid: false, reason: reason.trim() }
    }
    const idMatch = xml.match(/<customer_vault_id>([^<]+)<\/customer_vault_id>/)
    if (!idMatch || idMatch[1].trim() !== String(customerVaultId).trim()) {
      log.warn('vault.validate.mismatch', { customerVaultId, returned: idMatch?.[1] })
      return { valid: false, reason: 'vault id not present in NMI response' }
    }
    log.info('vault.validate.ok', { customerVaultId })
    return { valid: true }
  } catch (err) {
    log.warn('vault.validate.failed', { customerVaultId, err })
    return { valid: false, reason: err?.message || 'vault lookup failed' }
  }
}

// Create a Customer Vault profile. Payment details are OPTIONAL — if
// none are supplied we create an empty profile (you'll need to attach a
// payment method via NMI's hosted tokenizer before any charge succeeds).
//
// Note: NMI's Customer Vault operations use the `customer_vault` request
// parameter, NOT `type`. (`type=add_customer` returns "Invalid Transaction
// Type" because `type` is reserved for sale/auth/capture/refund/void/credit.)
//
// paymentDetails accepts EITHER:
//   { paymentToken }                              ← Collect.js / hosted form
//   { cardNumber, cardExpiry: 'MMYY', cardCvv? } ← raw PAN (PCI-scope!)
//   { achRouting, achAccount, achAccountType }   ← echeck
export async function createCustomerVault({ profile, paymentDetails }) {
  const params = {
    customer_vault: 'add_customer',
    first_name: profile.firstName,
    last_name: profile.lastName,
    company: profile.companyName,
    phone: profile.phone,
  }
  if (profile.billingAddress) {
    Object.assign(params, {
      address1: profile.billingAddress.line1,
      address2: profile.billingAddress.line2,
      city: profile.billingAddress.city,
      state: profile.billingAddress.state,
      zip: profile.billingAddress.zip,
      country: profile.billingAddress.country,
    })
  }
  if (profile.shippingAddress) {
    Object.assign(params, {
      shipping_address1: profile.shippingAddress.line1,
      shipping_address2: profile.shippingAddress.line2,
      shipping_city: profile.shippingAddress.city,
      shipping_state: profile.shippingAddress.state,
      shipping_zip: profile.shippingAddress.zip,
      shipping_country: profile.shippingAddress.country,
    })
  }

  if (paymentDetails?.paymentToken) {
    params.payment_token = paymentDetails.paymentToken
  } else if (paymentDetails?.cardNumber) {
    params.ccnumber = paymentDetails.cardNumber
    params.ccexp = paymentDetails.cardExpiry
    if (paymentDetails.cardCvv) params.cvv = paymentDetails.cardCvv
  } else if (paymentDetails?.achAccount) {
    params.payment = 'check'
    params.checkname = paymentDetails.checkName || `${profile.firstName || ''} ${profile.lastName || ''}`.trim()
    params.checkaba = paymentDetails.achRouting
    params.checkaccount = paymentDetails.achAccount
    params.account_type = paymentDetails.achAccountType || 'checking'
  }

  log.info('vault.create.request', { email: profile.email, hasPayment: Boolean(paymentDetails) })
  const res = await nmiTransact(params, { sensitiveKeys: NMI_SENSITIVE_PARAMS })
  if (res.response !== '1' || !res.customer_vault_id) {
    const err = new Error(`NMI add_customer failed: ${res.responsetext || 'unknown'}`)
    err.permanent = true
    err.nmiResponse = res
    throw err
  }
  log.info('vault.create.success', { customerVaultId: res.customer_vault_id })
  return res.customer_vault_id
}

export async function findOrCreateCustomerVault({ profile, paymentDetails }) {
  console.log(`\n[customers] NMI vault lookup for ${profile.email}`)
  const existing = await findCustomerVaultByEmail(profile.email)
  if (existing) {
    console.log(`[customers] NMI vault match found — id=${existing}`)
    log.info('vault.found.existing', { customerVaultId: existing, email: profile.email })
    return { customerVaultId: existing, created: false }
  }
  console.log(`[customers] NMI vault no match — creating new${paymentDetails ? ' (with payment method)' : ' (without payment method)'}`)
  const customerVaultId = await createCustomerVault({ profile, paymentDetails })
  console.log(`[customers] NMI vault created — id=${customerVaultId}`)
  return { customerVaultId, created: true }
}

// ── Sale / refund / void ─────────────────────────────────────────────

// Charge a stored payment method. The vault id MUST already exist —
// this is the production path used by the recurring scheduler.
//
// `billingId` is OPTIONAL. NMI's Customer Vault model lets a single
// vault hold multiple billing profiles (e.g. one card + one ACH); each
// billing entry has its own `billing_id`. When omitted, NMI charges
// the vault's DEFAULT billing. When supplied, NMI targets that
// specific billing entry — this is how we route ACH-method invoices
// against the ACH billing profile (id stored at
// wholesale_applications.payment.ach.nmi_billing_id) while card-method
// invoices on the same vault stay on the default card billing.
export async function chargeCustomerVault({ customerVaultId, billingId, amount, currency, orderId, invoiceNumber }) {
  if (!customerVaultId) throw new Error('chargeCustomerVault: customerVaultId is required')
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`chargeCustomerVault: amount must be > 0, got ${amount}`)
  }

  const params = {
    type: 'sale',
    customer_vault_id: customerVaultId,
    amount: amount.toFixed(2),
    currency: currency || 'USD',
    orderid: orderId,
    order_description: invoiceNumber ? `Invoice ${invoiceNumber}` : undefined,
  }
  if (billingId) params.billing_id = billingId

  console.log(
    `\n[NMI charge] vault=${customerVaultId}${billingId ? ` billing=${billingId}` : ''} ` +
      `amount=$${amount.toFixed(2)} order=${orderId}`,
  )
  log.info('charge.request', { customerVaultId, billingId: billingId || null, amount, orderId, invoiceNumber })

  const res = await nmiTransact(params)
  const result = classifyNmiResponse(res)

  console.log(`[NMI charge] outcome=${result.outcome.toUpperCase()} txn=${result.transactionId || '-'} code=${result.responseCode} "${result.responseText}"`)
  log.info('charge.response', {
    outcome: result.outcome,
    transactionId: result.transactionId,
    responseCode: result.responseCode,
    responseText: result.responseText,
    authCode: result.authCode,
  })
  return result
}

// ── Read-only listing helpers (admin dashboard) ──────────────────────
//
// NMI's `query.php` returns XML, not the key=value form transact.php uses.
// We deliberately avoid pulling in an XML parser dependency — the response
// shape is shallow + well-known, so a small regex-based block extractor
// gives us everything the admin UI needs.
//
// Two report shapes are consumed here:
//   report_type=transaction      → <nm_response><transaction>…</transaction>…
//   report_type=customer_vault   → <customer_vault><customer>…</customer>…
//
// Each list call returns the FULL matching window — NMI's query.php has
// no STARTPOSITION/MAXRESULTS pagination knobs (`report_limit` is a
// per-row depth limit, not a page size). Loaders constrain the window
// with `start_date` / `end_date` (mandatory in our paths, default last
// 30 days) and paginate the parsed array client-side. For very high-
// volume tenants the UI could fall behind — surface that with a
// "showing first N of M" disclaimer if the parsed count climbs.

// Render-time helpers (toNmiDate, fromNmiDate, latestAction) and the
// XML parsers (parseNmiTransactions, parseNmiCustomerVaults) live in
// nmi.utils.js — they're imported above and re-exported at the bottom
// of this file so server-only callers can use either import path.

// Build the date-range pair NMI's query.php expects. Defaults to the
// trailing 30 days when neither bound is supplied — keeps queries from
// accidentally pulling years of data.
function resolveDateRange({ startDate, endDate, defaultDays = 30 } = {}) {
  let end = endDate ? new Date(endDate) : new Date()
  if (!Number.isFinite(end.getTime())) end = new Date()
  let start
  if (startDate) {
    start = new Date(startDate)
    if (!Number.isFinite(start.getTime())) start = null
  }
  if (!start) {
    start = new Date(end)
    start.setDate(start.getDate() - defaultDays)
  }
  return { startDate: start, endDate: end }
}

// Fetch a transaction window from NMI. Filters are passed through
// directly to query.php — see NMI's "Direct Post API – query.php" docs
// for the full predicate list. The four we use most:
//
//   condition       — pending / pendingsettlement / failed / canceled /
//                     complete / in_progress / abandoned / unknown
//   transaction_type— cc (card) / ck (check) / cs (cash)
//   action_type     — sale / refund / credit / auth / capture / void
//   result          — 1 (approved) / 2 (declined) / 3 (error)
//
// Returns `{ records, startDate, endDate }`. Records is the parsed
// transaction array (newest first — we sort here because NMI's own
// ordering is "oldest first" which is the opposite of what the admin
// UI wants).
export async function listNmiTransactions(opts = {}) {
  const { startDate, endDate } = resolveDateRange(opts)
  const params = {
    report_type: 'transaction',
    start_date: toNmiDate(startDate),
    end_date: toNmiDate(endDate),
  }
  if (opts.condition) params.condition = opts.condition
  if (opts.transactionType) params.transaction_type = opts.transactionType
  if (opts.actionType) params.action_type = opts.actionType
  if (opts.result != null) params.result = opts.result
  if (opts.customerVaultId) params.customer_vault_id = opts.customerVaultId
  if (opts.transactionId) params.transaction_id = opts.transactionId
  if (opts.orderId) params.order_id = opts.orderId
  if (opts.invoiceId) params.invoice_id = opts.invoiceId

  const xml = await nmiQuery(params)
  const records = parseNmiTransactions(xml)

  // NMI returns actions oldest-first per transaction, but the
  // transactions themselves come in creation order. Newest-first reads
  // more naturally on an admin dashboard, so we sort on the LATEST
  // action's date.
  records.sort((a, b) => {
    const da = latestAction(a)?.date || ''
    const db = latestAction(b)?.date || ''
    return db.localeCompare(da)
  })

  return { records, startDate, endDate }
}

// Fetch the customer-vault list. Optional filters: `email`,
// `customerVaultId`. Without filters NMI returns the full vault — for
// a busy merchant that can be thousands of rows, so the loader
// paginates client-side.
//
// Returns `{ records, debug }` where `debug` is metadata the route
// loader can use to distinguish "NMI returned an empty vault" from
// "parser couldn't find entries in a non-empty response" (the
// wrapper-element drift bug). The route surfaces the latter as a
// warning banner so admins know to check the server logs.
export async function listNmiCustomerVaults(opts = {}) {
  const params = { report_type: 'customer_vault' }
  if (opts.email) params.email = opts.email
  if (opts.customerVaultId) params.customer_vault_id = opts.customerVaultId
  const xml = await nmiQuery(params)
  const records = parseNmiCustomerVaults(xml)
  records.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))

  // Detect the NMI "no records found" sentinel response — gateway
  // returns either an empty wrapper element OR a literal "No Records
  // Found" string depending on version.
  const isEmptyResponse =
    xml.length < 200 || /No Records Found/i.test(xml) ||
    /<customer_vault\s*\/>/i.test(xml)
  // The error_response sentinel — surface the reason if present.
  let errorMessage = null
  const errMatch = xml.match(/<error_response>([\s\S]*?)<\/error_response>/i)
  if (errMatch) errorMessage = errMatch[1].trim()

  return {
    records,
    debug: {
      xmlLength: xml.length,
      // First 4KB of the raw XML, exposed so the UI's diagnostic panel
      // can show what NMI actually returned. Operators can paste this
      // into a bug report when parser output looks wrong (e.g. "I have
      // 6 vault entries in the NMI admin but only 1 shows here").
      // 4KB is enough to see the wrapper structure + the first
      // ~2 entries without ballooning the loader response.
      xmlPreview: xml.slice(0, 4000),
      isEmptyResponse,
      errorMessage,
      // Help the route render a useful banner when the parser shape
      // doesn't match what NMI returned. True ONLY when NMI sent a
      // non-trivial response but the parser couldn't pull any entries
      // out — that's a wrapper-element drift bug, not an empty vault.
      parserShapeMismatch:
        records.length === 0 && !isEmptyResponse && !errorMessage,
    },
  }
}

// Composite metrics for the NMI Dashboard tab. One query window
// (last 30 days by default) drives every count + the recent-
// transactions list. Customer-vault total is a separate call.
//
// Per-metric failures degrade to `null` and are surfaced via the
// returned `errors[]` array — same pattern QBO's dashboard helper
// uses, so the UI can present a single warning banner.
export async function getNmiDashboardSnapshot({ startDate, endDate, periodDays = 30 } = {}) {
  const range = resolveDateRange({ startDate, endDate, defaultDays: periodDays })
  const errors = []
  const safe = async (label, fn) => {
    try {
      return await fn()
    } catch (e) {
      errors.push({ label, message: e?.message || String(e) })
      return null
    }
  }

  const [txWindow, vaults] = await Promise.all([
    safe('Transactions window', () =>
      listNmiTransactions({ startDate: range.startDate, endDate: range.endDate }),
    ),
    safe('Customer vaults', () => listNmiCustomerVaults()),
  ])

  // Aggregate the window in JS — NMI has no equivalent of SUM/COUNT
  // group-by, so we walk the parsed array. This is fine for the kinds
  // of volumes Direct Post merchants see (hundreds to low thousands per
  // month). At ~10k/month we'd need to switch to multi-window calls or
  // a local cache.
  let totalTransactions = null
  let successfulPayments = null
  let failedPayments = null
  let achPayments = null
  let creditCardPayments = null
  let refundCount = null
  let refundTotal = null
  let paymentsTotal = null
  let recentTransactions = []

  if (txWindow?.records) {
    const recs = txWindow.records
    totalTransactions = recs.length
    successfulPayments = 0
    failedPayments = 0
    achPayments = 0
    creditCardPayments = 0
    refundCount = 0
    refundTotal = 0
    paymentsTotal = 0

    for (const tx of recs) {
      const last = latestAction(tx)
      const isSuccess = last?.success === '1'
      const actionType = (last?.action_type || '').toLowerCase()
      const amount = Number(last?.amount || 0)
      const condition = (tx.condition || '').toLowerCase()
      const txType = (tx.transaction_type || '').toLowerCase()

      if (txType === 'ck') achPayments += 1
      else if (txType === 'cc') creditCardPayments += 1

      if (actionType === 'refund') {
        refundCount += 1
        if (isSuccess) refundTotal += amount
      } else {
        // Payment-side outcomes — sale / auth / capture etc.
        if (isSuccess) {
          successfulPayments += 1
          if (actionType === 'sale' || actionType === 'capture') {
            paymentsTotal += amount
          }
        } else {
          failedPayments += 1
        }
      }

      // Also count NMI condition='failed' (covers gateway-rejected
      // transactions that may not have an action row).
      if (condition === 'failed') {
        // Avoid double-counting — only increment if the action loop
        // didn't already tag this row as failed.
        if (last && last.success === '1') {
          // shouldn't happen, but guard anyway
        }
      }
    }

    refundTotal = Number(refundTotal.toFixed(2))
    paymentsTotal = Number(paymentsTotal.toFixed(2))

    // Newest 10 for the "Recent transactions" panel.
    recentTransactions = recs.slice(0, 10)
  }

  return {
    asOf: new Date().toISOString(),
    periodStart: range.startDate.toISOString(),
    periodEnd: range.endDate.toISOString(),
    periodDays,
    counts: {
      customers: vaults?.records?.length ?? null,
      transactions: totalTransactions,
      successful: successfulPayments,
      failed: failedPayments,
      ach: achPayments,
      creditCard: creditCardPayments,
      refunds: refundCount,
    },
    totals: {
      paymentsAmount: paymentsTotal,
      refundsAmount: refundTotal,
      currency: 'USD',
    },
    recentTransactions,
    errors,
  }
}

// Fetch the current state of a single NMI transaction by id. Used by
// the ACH settlement-check CRON pass to decide whether an awaiting-
// settlement invoice has cleared (`condition='complete'`), bounced
// (`condition='failed'` / `'canceled'`), or is still working through
// the ACH network (`condition='pendingsettlement'` / `'pending'`).
//
// Returns:
//   { found: true, condition, latestAction, transaction }
//     where `condition` is the NMI condition string (lowercased) and
//     `latestAction` is the most-recent action row (may carry settle/
//     return metadata depending on the gateway's state)
//   { found: false, reason }
//     transport / parsing failure, or NMI returned no matching row.
//     Callers MUST treat this as "no information" — never as a settle
//     or fail signal.
export async function getNmiTransactionStatus(transactionId) {
  if (!transactionId) return { found: false, reason: 'no transactionId provided' }
  try {
    const xml = await nmiQuery({ transaction_id: transactionId })
    if (/<error_response>/i.test(xml)) {
      const reason = (xml.match(/<error_response>([^<]+)<\/error_response>/i) || [])[1] || 'NMI error_response'
      log.warn('txn.status.error_response', { transactionId, reason })
      return { found: false, reason: reason.trim() }
    }
    const records = parseNmiTransactions(xml)
    const transaction = records.find((r) => String(r.transaction_id || '') === String(transactionId)) || records[0]
    if (!transaction) {
      return { found: false, reason: 'no transaction records returned' }
    }
    const condition = String(transaction.condition || '').toLowerCase()
    const last = latestAction(transaction)
    return { found: true, condition, latestAction: last, transaction }
  } catch (err) {
    log.warn('txn.status.failed', { transactionId, err: err?.message || String(err) })
    return { found: false, reason: err?.message || 'transaction status fetch failed' }
  }
}

// Optional helper for admin tooling — refund or void a prior transaction.
export async function refundTransaction({ transactionId, amount }) {
  const params = { type: 'refund', transactionid: transactionId }
  if (amount) params.amount = amount.toFixed(2)
  const res = await nmiTransact(params)
  return classifyNmiResponse(res)
}

export async function voidTransaction({ transactionId }) {
  const res = await nmiTransact({ type: 'void', transactionid: transactionId })
  return classifyNmiResponse(res)
}
