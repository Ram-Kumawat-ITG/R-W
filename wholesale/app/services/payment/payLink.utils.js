// Immediate-Payment pay-link helpers — token minting, public URL
// building, and QR PNG rendering. Server-only (renderPayQrPng pulls the
// `qrcode` lib and buildPayLinkUrl reads shopifyConfig). Keep these out of
// client render code; the pay routes use them from loaders/actions only.

import crypto from 'node:crypto'
import QRCode from 'qrcode'
import { shopifyConfig } from '../shopify/shopify.config'

// Opaque, unguessable bearer token stored on the Invoice (Invoice.payToken)
// and embedded in the public /pay/<token> URL. 32 random bytes → 43-char
// base64url string. It carries NO amount — the outstanding balance is always
// recomputed server-side at click time (defeats amount tampering), and the
// 256-bit space defeats enumeration.
export function mintPayToken() {
  return crypto.randomBytes(32).toString('base64url')
}

// Build the durable public pay URL for a token. Uses the app's public
// base URL (SHOPIFY_APP_URL via shopifyConfig.appUrl). Trailing slash on
// the base is tolerated.
export function buildPayLinkUrl(token, baseUrl = shopifyConfig.appUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return `${base}/pay/${encodeURIComponent(token)}`
}

// Render a payment URL to a PNG QR-code Buffer for the QBO invoice
// attachment. Medium error-correction + a quiet-zone margin so it scans
// reliably from a printed/emailed invoice.
export async function renderPayQrPng(url, { width = 320 } = {}) {
  return QRCode.toBuffer(String(url), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width,
  })
}

// Render a payment URL to a data: URI (PNG) — used by the public pay page
// and the admin Order Details view to show the QR inline without a second
// request.
export async function renderPayQrDataUrl(url, { width = 240 } = {}) {
  return QRCode.toDataURL(String(url), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width,
  })
}
