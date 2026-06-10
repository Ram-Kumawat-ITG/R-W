// Public Immediate-Payment self-pay page — GET/POST /pay/:token.
//
// The durable link + QR on the QBO invoice point here. The page renders an
// NMI Collect.js card form (iframe fields — card data is tokenized by NMI
// client-side and never touches our server), then POSTs the one-time
// payment_token back to this route's action, which charges the EXACT
// outstanding balance (recomputed server-side) and settles the invoice.
//
// No Shopify auth — security is the unguessable token + server-side amount
// derivation. No card data is ever received or stored by us.

import { useEffect, useRef, useState } from 'react'
import { useLoaderData, useFetcher } from 'react-router'
import Invoice from '../../models/invoice.server'
import CustomerMap from '../../models/customerMap.server'
import { nmiConfig } from '../../services/nmi/nmi.config'
import { chargeWithPaymentToken } from '../../services/nmi/nmi.service'
import { settleHostedPayment, invoiceOutstanding } from '../../services/payment/payLink.service'
import { PayResult, formatMoney } from '../../components/pay-ui'

export async function loader({ params }) {
  const token = params.token
  const invoice = token ? await Invoice.findOne({ payToken: token }) : null

  if (!invoice) return { status: 'not_found' }
  if (invoice.paymentStatus === 'cancelled' || invoice.paymentStatus === 'refunded') {
    return { status: 'unavailable' }
  }
  const outstanding = invoiceOutstanding(invoice)
  if (invoice.paymentStatus === 'paid' || outstanding <= 0.005) {
    return { status: 'paid', currency: invoice.currency }
  }

  return {
    status: 'payable',
    amount: outstanding,
    currency: invoice.currency || 'USD',
    docNumber: invoice.qboDocNumber || invoice.shopifyOrderId,
    tokenizationKey: nmiConfig.publicKey,
    collectJsUrl: nmiConfig.collectJsUrl,
  }
}

export async function action({ request, params }) {
  const token = params.token
  const form = await request.formData()
  const paymentToken = form.get('paymentToken')

  const invoice = token ? await Invoice.findOne({ payToken: token }) : null
  if (!invoice) return { ok: false, message: 'Invoice not found.' }
  if (invoice.paymentStatus === 'paid' || invoiceOutstanding(invoice) <= 0.005) {
    return { ok: true, alreadyPaid: true, currency: invoice.currency }
  }
  if (invoice.paymentStatus === 'cancelled' || invoice.paymentStatus === 'refunded') {
    return { ok: false, message: 'This invoice is no longer payable.' }
  }
  if (!paymentToken) {
    return { ok: false, message: 'Missing payment token. Please re-enter your card and try again.' }
  }

  // Amount is ALWAYS the server-derived outstanding balance — never trust a
  // client-supplied amount.
  const amount = invoiceOutstanding(invoice)

  let result
  try {
    result = await chargeWithPaymentToken({
      paymentToken: String(paymentToken),
      amount,
      currency: invoice.currency || 'USD',
      orderId: invoice.shopifyOrderId,
      invoiceNumber: invoice.qboDocNumber || invoice.shopifyOrderId,
    })
  } catch (err) {
    console.error(`[pay] charge failed for invoice ${invoice._id}: ${err.message}`)
    return { ok: false, message: 'We could not process your card right now. Please try again.' }
  }

  if (result.outcome !== 'approved' || !result.transactionId) {
    return { ok: false, message: result.responseText || 'Your card was declined. Please try a different card.' }
  }

  // Settle through the shared path (QBO Payment + Shopify mark-paid +
  // local order/invoice state), idempotent on the NMI transaction id. If
  // bookkeeping fails AFTER the charge captured, we still show success —
  // the money is taken — and rely on logs + sync to reconcile.
  const customerMap = await CustomerMap.findById(invoice.customerMapRef)
  try {
    await settleHostedPayment({ invoice, customerMap, transactionId: result.transactionId, amount })
  } catch (err) {
    console.error(`[pay] settlement bookkeeping failed (payment WAS captured) invoice ${invoice._id}: ${err.message}`)
  }

  return { ok: true, amount, currency: invoice.currency }
}

export default function PayPage() {
  const data = useLoaderData()

  if (data.status === 'paid') {
    return (
      <PayResult
        tone="success"
        title="Payment Successful!"
        message="Your payment has been received and processed successfully. No further action is required. You may now safely close this window."
      />
    )
  }
  if (data.status === 'unavailable') {
    return (
      <PayResult
        tone="neutral"
        title="This invoice is no longer payable"
        message="It may have been cancelled. If you believe this is a mistake, please contact wholesale@naturalsolutionsphc.com."
      />
    )
  }
  if (data.status === 'not_found') {
    return (
      <PayResult
        tone="neutral"
        title="Payment link not found"
        message="This payment link is invalid or has expired. Please check the link in your invoice email, or contact wholesale@naturalsolutionsphc.com."
      />
    )
  }

  return <CollectCheckout {...data} />
}

function CollectCheckout({ amount, currency, docNumber, tokenizationKey, collectJsUrl }) {
  const fetcher = useFetcher()
  const [fieldsReady, setFieldsReady] = useState(false)
  const [error, setError] = useState(null)
  const [tokenizing, setTokenizing] = useState(false)
  const configured = useRef(false)
  const submitRef = useRef(null)

  // Keep the latest submit fn reachable from Collect.js's stable callback.
  submitRef.current = (paymentToken) => {
    fetcher.submit({ paymentToken }, { method: 'post' })
  }

  useEffect(() => {
    if (configured.current) return
    configured.current = true

    loadCollectJs(collectJsUrl, tokenizationKey)
      .then(() => {
        window.CollectJS.configure({
          variant: 'inline',
          styleSniffer: false,
          fields: {
            ccnumber: { selector: '#collect-ccnumber', placeholder: '1234 5678 9012 3456' },
            ccexp: { selector: '#collect-ccexp', placeholder: 'MM / YY' },
            cvv: { selector: '#collect-cvv', placeholder: 'CVV' },
          },
          // Style the contents of the NMI iframes so they sit flush inside our
          // own bordered field shells (the shell owns the border/focus ring;
          // the iframe input must be fully reset — no border/background/padding/
          // native appearance of its own — or it draws a second box inside our
          // shell, including a dark focus outline when clicked). This mirrors
          // the proven config in registration-form/PaymentCardForm.jsx.
          customCss: {
            'font-size': '16px',
            'font-family':
              'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            color: '#18181b',
            'line-height': '44px',
            height: '44px',
            background: 'transparent',
            'background-color': 'transparent',
            border: 'none',
            'border-width': '0',
            'border-radius': '0',
            outline: 'none',
            'box-shadow': 'none',
            '-webkit-appearance': 'none',
            '-moz-appearance': 'none',
            appearance: 'none',
            width: '100%',
            margin: '0',
            padding: '0',
          },
          focusCss: {
            color: '#18181b',
            border: 'none',
            outline: '0px',
            'outline-width': '0',
            'outline-style': 'none',
            'box-shadow': 'none',
          },
          placeholderCss: { color: '#a1a1aa' },
          invalidCss: { color: '#b42318', border: 'none', 'box-shadow': 'none' },
          validCss: { color: '#0f7b3f', border: 'none' },
          fieldsAvailableCallback: () => setFieldsReady(true),
          validationCallback: (_field, status, message) => {
            if (!status) {
              setTokenizing(false)
              setError(message || 'Please check your card details.')
            }
          },
          timeoutCallback: () => {
            setTokenizing(false)
            setError('The payment fields timed out. Please try again.')
          },
          callback: (response) => {
            if (response?.token) {
              setError(null)
              submitRef.current?.(response.token)
            } else {
              setTokenizing(false)
              setError('Card tokenization failed. Please check your details and try again.')
            }
          },
        })
      })
      .catch((err) => setError(`Payment fields failed to load: ${err.message}`))
  }, [collectJsUrl, tokenizationKey])

  const submitting = tokenizing || fetcher.state !== 'idle'

  // Terminal states from the action.
  if (fetcher.data?.ok) {
    return (
      <PayResult
        tone="success"
        title="Payment Successful"
        amount={Number.isFinite(fetcher.data.amount) ? fetcher.data.amount : undefined}
        currency={fetcher.data.currency || currency}
        message={
          'Thank you! Your payment has been received and processed successfully.\n\n' +
          'No further action is required. You may now safely close this window.'
        }
      />
    )
  }

  // A failed charge from the server is a terminal result — show a clear failure
  // screen (red ✕) with a Try-again that reloads a fresh payment form. No money
  // is ever captured on an ok:false outcome, so we can reassure the customer.
  if (fetcher.data && fetcher.data.ok === false) {
    return (
      <PayResult
        tone="critical"
        title="Payment Failed"
        message={
          (fetcher.data.message || 'Your payment could not be processed.') +
          '\n\nNo charge was made to your card. Please check your details and try again, ' +
          'or contact wholesale@naturalsolutionsphc.com if the problem continues.'
        }
        action={{ label: 'Try again', onClick: () => window.location.reload() }}
      />
    )
  }

  // Client-side issues (validation / tokenization / load) stay inline so the
  // customer can correct them without leaving the form.
  const shownError = error

  const onPay = () => {
    setError(null)
    setTokenizing(true)
    try {
      window.CollectJS.startPaymentRequest()
    } catch {
      setTokenizing(false)
      setError('Could not start the payment. Please refresh and try again.')
    }
  }

  const disabled = !fieldsReady || submitting

  return (
    <div style={SHELL}>
      <style dangerouslySetInnerHTML={{ __html: PAY_CSS }} />
      <div style={CARD}>
        <div style={{ height: 4, width: 56, background: '#1f6feb', borderRadius: 4, margin: '0 auto 20px' }} />
        <h1 style={{ fontSize: 20, fontWeight: 600, color: '#1a1a1a', margin: '0 0 4px', textAlign: 'center' }}>
          Pay invoice {docNumber ? `#${docNumber}` : ''}
        </h1>
        <div style={{ fontSize: 34, fontWeight: 700, color: '#1f6feb', textAlign: 'center', margin: '8px 0 26px' }}>
          {formatMoney(amount, currency)}
        </div>

        <label style={LABEL} htmlFor="collect-ccnumber">Card number</label>
        <div id="collect-ccnumber" className="pay-field" style={FIELD} />

        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL} htmlFor="collect-ccexp">Expiry</label>
            <div id="collect-ccexp" className="pay-field" style={FIELD} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL} htmlFor="collect-cvv">CVV</label>
            <div id="collect-cvv" className="pay-field" style={FIELD} />
          </div>
        </div>

        {!fieldsReady && !shownError && (
          <p style={{ color: '#a1a1aa', fontSize: 13, margin: '14px 0 0', textAlign: 'center' }}>
            Loading secure payment fields…
          </p>
        )}

        {shownError && (
          <div style={ERROR_BOX} role="alert">
            <span style={ERROR_DOT} aria-hidden="true">!</span>
            <span>{shownError}</span>
          </div>
        )}

        <button
          type="button"
          onClick={onPay}
          disabled={disabled}
          className="pay-button"
          style={payButtonStyle(disabled)}
        >
          {submitting ? 'Processing…' : `Pay ${formatMoney(amount, currency)}`}
        </button>

        <p style={{ fontSize: 12, color: '#a1a1aa', textAlign: 'center', margin: '22px 0 0', letterSpacing: 0.2 }}>
          🔒 Secured by NMI · Natural Solutions Wholesale
        </p>
      </div>
    </div>
  )
}

// Pseudo-class styling that inline styles can't express: focus-within ring on
// the field shells, the NMI iframe filling its shell, and button hover.
const PAY_CSS = `
  .pay-field { transition: border-color .15s ease, box-shadow .15s ease; }
  .pay-field:hover { border-color: #b4b4bb; }
  .pay-field:focus-within {
    border-color: #1f6feb;
    box-shadow: 0 0 0 3px rgba(31,111,235,0.15);
  }
  .pay-field iframe { width: 100% !important; height: 100% !important; border: 0 !important; outline: 0 !important; box-shadow: none !important; }
  .pay-field iframe:focus, .pay-field iframe:focus-visible { outline: 0 !important; border: 0 !important; box-shadow: none !important; }
  .pay-button:not(:disabled):hover { background: #195bc7 !important; }
  .pay-button:not(:disabled):active { background: #1550b3 !important; }
`

// Load NMI's Collect.js once, attaching the publishable tokenization key.
function loadCollectJs(url, tokenizationKey) {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'))
    if (window.CollectJS) return resolve()
    if (!tokenizationKey) return reject(new Error('payment key not configured'))
    const existing = document.querySelector('script[data-tokenization-key]')
    if (existing) {
      const start = Date.now()
      const poll = () => {
        if (window.CollectJS) return resolve()
        if (Date.now() - start > 6000) return reject(new Error('Collect.js timed out'))
        setTimeout(poll, 100)
      }
      return poll()
    }
    const script = document.createElement('script')
    script.src = url
    script.setAttribute('data-tokenization-key', tokenizationKey)
    script.setAttribute('data-variant', 'inline')
    script.onload = () => (window.CollectJS ? resolve() : reject(new Error('Collect.js did not initialize')))
    script.onerror = () => reject(new Error('Failed to load Collect.js'))
    document.head.appendChild(script)
  })
}

const SHELL = {
  minHeight: '100vh',
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#f4f5f7',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  padding: 24,
}
const CARD = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.06)',
  maxWidth: 420,
  width: '100%',
  padding: '36px 32px',
}
const LABEL = { display: 'block', fontSize: 13, fontWeight: 600, color: '#3f3f46', margin: '16px 0 6px' }
const FIELD = {
  height: 44,
  border: '1px solid #d4d4d8',
  borderRadius: 10,
  padding: '0 12px',
  background: '#fff',
  boxSizing: 'border-box',
  overflow: 'hidden',
}
const ERROR_BOX = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: '#fef3f2',
  border: '1px solid #fecdca',
  color: '#b42318',
  fontSize: 14,
  lineHeight: 1.4,
  borderRadius: 10,
  padding: '10px 12px',
  margin: '16px 0 0',
}
const ERROR_DOT = {
  flex: '0 0 auto',
  width: 18,
  height: 18,
  borderRadius: '50%',
  background: '#b42318',
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  lineHeight: '18px',
  textAlign: 'center',
}
function payButtonStyle(disabled) {
  return {
    width: '100%',
    marginTop: 24,
    background: disabled ? '#9dbcf0' : '#1f6feb',
    color: '#fff',
    fontWeight: 600,
    fontSize: 16,
    padding: '14px 0',
    border: 'none',
    borderRadius: 10,
    cursor: disabled ? 'default' : 'pointer',
    boxShadow: disabled ? 'none' : '0 1px 2px rgba(31,111,235,0.4)',
    transition: 'background .15s ease',
  }
}
