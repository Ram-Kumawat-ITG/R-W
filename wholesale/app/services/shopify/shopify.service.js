// Shopify domain methods — what the rest of the app uses to talk to
// the Admin API. Combines order updates, webhook subscription management,
// customer lifecycle, and file uploads.
//
// All GraphQL strings are in shopify.queries.js / shopify.mutations.js.
// All low-level admin-client plumbing is in shopify.apis.js.

// Carries structured Shopify userErrors so callers can map fields back to form inputs.
export class ShopifyUserError extends Error {
  constructor(userErrors) {
    super(userErrors.map((e) => `[${Array.isArray(e.field) ? e.field.join('.') : e.field}] ${e.message}`).join('; '))
    this.name = 'ShopifyUserError'
    this.userErrors = userErrors
  }
}

import { shopifyConfig } from './shopify.config'
import { REQUIRED_SUBSCRIPTIONS } from './shopify.constants'
import { toE164US, mapAddress, toOrderGid } from './shopify.utils'
import {
  QUERY_WEBHOOK_SUBSCRIPTIONS_BY_TOPIC,
  QUERY_ALL_WEBHOOK_SUBSCRIPTIONS,
  QUERY_CUSTOMER_TAGS,
  QUERY_FILE_BY_ID,
} from './shopify.queries'
import {
  MUTATION_ORDER_MARK_AS_PAID,
  MUTATION_WEBHOOK_SUBSCRIPTION_CREATE,
  MUTATION_CUSTOMER_CREATE,
  MUTATION_CUSTOMER_SEND_INVITE,
  MUTATION_CUSTOMER_UPDATE,
  MUTATION_CUSTOMER_DELETE,
  MUTATION_ORDER_DELETE,
  MUTATION_STAGED_UPLOADS_CREATE,
  MUTATION_FILE_CREATE,
} from './shopify.mutations'
import { getUnauthenticatedAdmin, executeGraphQL, executeMutation } from './shopify.apis'
import { createLogger } from '../../utils/logger.utils'
import { PermanentError, TransientError } from '../../utils/retry.utils'

const log = createLogger('shopify.service')

// ── Orders ───────────────────────────────────────────────────────────

// Marks a Shopify order as paid. Returns the order's new
// displayFinancialStatus on success ("PAID"). Idempotent — Shopify
// returns a userError ("This order has already been paid") on the
// second call which we treat as success.
export async function markShopifyOrderPaid({ shop, shopifyOrderId }) {
  if (!shop || !shopifyOrderId) {
    throw new Error('markShopifyOrderPaid: shop and shopifyOrderId are required')
  }

  console.log(`[shopify] markShopifyOrderPaid shop=${shop} order=${shopifyOrderId}`)
  log.info('mark_paid.request', { shop, shopifyOrderId })

  const { admin } = await getUnauthenticatedAdmin(shop)
  const gid = toOrderGid(shopifyOrderId)

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_ORDER_MARK_AS_PAID,
    { input: { id: gid } },
    'orderMarkAsPaid',
  )

  // Idempotency: if Shopify says "already paid", treat as success.
  const alreadyPaid = userErrors.some((e) =>
    /already.*paid|already.*captured|fully paid/i.test(e.message || ''),
  )
  if (alreadyPaid) {
    console.log(`[shopify] order ${shopifyOrderId} was already paid — treating as success`)
    log.info('mark_paid.already_paid', { shop, shopifyOrderId })
    return { financialStatus: 'PAID', alreadyPaid: true }
  }

  if (userErrors.length) {
    const msg = userErrors.map((e) => e.message).join('; ')
    console.error(`[shopify] orderMarkAsPaid userErrors: ${msg}`)
    log.error('mark_paid.user_error', { shop, shopifyOrderId, userErrors })
    throw new PermanentError(`Shopify orderMarkAsPaid userErrors: ${msg}`, { body: userErrors })
  }

  const order = data?.order
  console.log(`[shopify] order ${shopifyOrderId} marked PAID — displayFinancialStatus=${order?.displayFinancialStatus}`)
  log.info('mark_paid.success', {
    shop,
    shopifyOrderId,
    financialStatus: order?.displayFinancialStatus,
  })
  return {
    financialStatus: order?.displayFinancialStatus,
    updatedAt: order?.updatedAt,
    alreadyPaid: false,
  }
}

// ── Webhook subscriptions ────────────────────────────────────────────

function callbackUrl(callbackPath) {
  const base = shopifyConfig.appUrl
  if (!base) throw new Error('SHOPIFY_APP_URL not set; cannot build webhook callback URL')
  return `${base.replace(/\/$/, '')}${callbackPath}`
}

async function existingSubscriptions(admin, topic) {
  const json = await executeGraphQL(admin, QUERY_WEBHOOK_SUBSCRIPTIONS_BY_TOPIC, { topics: [topic] })
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || []
}

async function createSubscription(admin, { topic, callbackPath }) {
  const url = callbackUrl(callbackPath)
  const { userErrors, data } = await executeMutation(
    admin,
    MUTATION_WEBHOOK_SUBSCRIPTION_CREATE,
    { topic, sub: { callbackUrl: url, format: 'JSON' } },
    'webhookSubscriptionCreate',
  )
  if (userErrors.length) {
    // Most likely cause in dev: "not approved for protected customer data".
    throw new Error(
      `webhookSubscriptionCreate(${topic}): ${userErrors.map((e) => e.message).join('; ')}`,
    )
  }
  return data?.webhookSubscription?.id
}

// In-memory guard so a busy admin session doesn't spam the existence
// check on every loader. Keyed by shop domain.
const registered = new Set()

// Idempotently ensure every required subscription is registered. Safe to
// call on every authenticated admin request — most invocations are
// in-memory no-ops once registration has succeeded once per process.
//
// Failures are logged but never thrown to the caller, so a missing
// Partners approval doesn't break the embedded admin UI.
export async function ensureProtectedWebhooks({ admin, shop }) {
  if (!shop || !admin) return
  if (registered.has(shop)) return

  console.log(`\n========== Webhook registration check: ${shop} ==========`)
  for (const sub of REQUIRED_SUBSCRIPTIONS) {
    try {
      const desiredUrl = callbackUrl(sub.callbackPath)
      const existing = await existingSubscriptions(admin, sub.topic)
      const match = existing.find((s) => s.endpoint?.callbackUrl === desiredUrl)
      if (match) {
        console.log(`  [OK]      ${sub.topic} already subscribed → ${desiredUrl}`)
        log.info('subscription.present', { shop, topic: sub.topic, url: desiredUrl })
        continue
      }
      const id = await createSubscription(admin, sub)
      console.log(`  [CREATED] ${sub.topic} → ${desiredUrl}  (id=${id})`)
      log.info('subscription.created', { shop, topic: sub.topic, id, url: desiredUrl })
    } catch (err) {
      console.log(`  [FAILED]  ${sub.topic}: ${err.message}`)
      console.log('            → This usually means the app is not approved for')
      console.log('              protected customer data. Approve in Partners dashboard:')
      console.log('              Partners → your app → API access → Protected customer data')
      log.warn('subscription.skipped', { shop, topic: sub.topic, reason: err.message })
    }
  }
  console.log('=========================================================\n')

  registered.add(shop)
}

// List every webhook subscription registered for this shop (regardless
// of topic). Used by the /app/webhooks diagnostic page.
export async function listAllWebhookSubscriptions(admin) {
  const json = await executeGraphQL(admin, QUERY_ALL_WEBHOOK_SUBSCRIPTIONS)
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || []
}

// ── Customers ────────────────────────────────────────────────────────

// Create a customer with marketing consent + initial tags + the wholesale
// note. Used by the registration-form submission flow.
export async function createCustomer(admin, { application, note, tags = ['Pending'], subscribeNews = false }) {
  const addresses = []
  if (application.billingAddress) {
    addresses.push({
      ...mapAddress(application.billingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
      phone: toE164US(application.phone),
    })
  }
  if (!application.shippingSameAsBilling && application.shippingAddress) {
    addresses.push({
      ...mapAddress(application.shippingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
      phone: toE164US(application.phone),
    })
  }

  const input = {
    email: application.email,
    firstName: application.firstName,
    lastName: application.lastName,
    tags,
    note,
    addresses,
    emailMarketingConsent: {
      marketingState: subscribeNews ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED',
      marketingOptInLevel: subscribeNews ? 'SINGLE_OPT_IN' : null,
      // Back-date 60s so clock skew with Shopify can't trigger "must not be in the future".
      consentUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  }

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_CREATE,
    { input },
    'customerCreate',
  )
  if (userErrors.length) throw new ShopifyUserError(userErrors)
  const id = data?.customer?.id
  if (!id) throw new Error('customerCreate returned no customer')
  return id
}

export async function sendCustomerInvite(admin, { customerId, subject, message, fromEmail }) {
  const emailInput = {}
  if (subject) emailInput.subject = subject
  if (message) emailInput.customMessage = message
  if (fromEmail) emailInput.from = fromEmail

  const { userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_SEND_INVITE,
    {
      customerId,
      email: Object.keys(emailInput).length ? emailInput : null,
    },
    'customerSendAccountInviteEmail',
  )
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join('; '))
  return true
}

// Fetch the current tags for a Shopify customer using an offline session
// (no request context required — callable from webhook handlers and the
// scheduler). Returns [] if the customer can't be found.
//
// Webhook payloads do include `customer.tags`, but that's a snapshot at
// order creation. For approval gating we want the LIVE state — so a
// customer who was tagged "Approved" between order creation and webhook
// arrival is processed correctly.
export async function getCustomerTags({ shop, customerId }) {
  if (!shop || !customerId) {
    throw new Error('getCustomerTags: shop and customerId are required')
  }
  const gid = String(customerId).startsWith('gid://')
    ? String(customerId)
    : `gid://shopify/Customer/${customerId}`

  const { admin } = await getUnauthenticatedAdmin(shop)
  const json = await executeGraphQL(admin, QUERY_CUSTOMER_TAGS, { id: gid })
  const tags = json?.data?.customer?.tags
  if (!Array.isArray(tags)) return []
  return tags
}

// Convenience predicate used by the order orchestrator's approval gate.
// Case-insensitive match against the literal "Approved" tag we set when
// an admin approves a wholesale application (see admin/review.js).
export async function customerHasApprovedTag({ shop, customerId }) {
  if (!shop || !customerId) return false
  const tags = await getCustomerTags({ shop, customerId })
  return tags.some((t) => String(t).trim().toLowerCase() === 'approved')
}

// Swap one tag for another on a Shopify customer. Reads current tags,
// removes `removeTag`, adds `addTag`, writes back.
export async function updateCustomerTags(admin, { customerId, addTag, removeTag }) {
  const readJson = await executeGraphQL(admin, QUERY_CUSTOMER_TAGS, { id: customerId })
  const current = readJson?.data?.customer?.tags || []
  const next = Array.from(
    new Set([...current.filter((t) => t !== removeTag), addTag]),
  )

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_UPDATE,
    { input: { id: customerId, tags: next } },
    'customerUpdate',
  )
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join('; '))
  return data?.customer?.tags || next
}

export async function deleteCustomer(admin, customerId) {
  const { userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_DELETE,
    { id: customerId },
    'customerDelete',
  )
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join('; '))
  return true
}

export async function deleteOrder(admin, shopifyOrderId) {
  const orderGid = toOrderGid(shopifyOrderId)
  const { userErrors } = await executeMutation(
    admin,
    MUTATION_ORDER_DELETE,
    { orderId: orderGid },
    'orderDelete',
  )
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join('; '))
  return true
}

// ── File uploads ─────────────────────────────────────────────────────

// Multi-step Shopify Files API upload. Returns the permanent CDN URL once
// the file is READY. Used by the registration-form proxy for license
// uploads, signature PNGs, etc.
//
// Three round-trips: staged upload target → bytes upload → fileCreate.
// If fileCreate returns a URL synchronously we skip the polling step.
export async function uploadFileToShopify(admin, file) {
  const isImage = (file.type || '').startsWith('image/')
  const resourceKind = isImage ? 'IMAGE' : 'FILE'

  // 1. Get a staged upload target
  const stagedJson = await executeGraphQL(admin, MUTATION_STAGED_UPLOADS_CREATE, {
    input: [
      {
        filename: file.name || 'upload',
        mimeType: file.type || 'application/octet-stream',
        fileSize: String(file.size),
        httpMethod: 'POST',
        resource: resourceKind,
      },
    ],
  })
  const stagedErrors = stagedJson?.data?.stagedUploadsCreate?.userErrors
  if (stagedErrors?.length) {
    throw new Error(`stagedUploadsCreate: ${stagedErrors.map((e) => e.message).join('; ')}`)
  }
  const target = stagedJson?.data?.stagedUploadsCreate?.stagedTargets?.[0]
  if (!target?.url) throw new Error('No staged target returned')

  // 2. Upload the bytes to the staged target (Shopify-hosted S3-compatible bucket)
  const upload = new FormData()
  for (const p of target.parameters || []) upload.append(p.name, p.value)
  upload.append('file', file, file.name || 'upload')

  const putRes = await fetch(target.url, { method: 'POST', body: upload })
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => '')
    throw new Error(`Staged upload failed (${putRes.status}): ${txt.slice(0, 200)}`)
  }

  // 3. Register the uploaded resource as a Shopify File
  const createdJson = await executeGraphQL(admin, MUTATION_FILE_CREATE, {
    files: [
      {
        originalSource: target.resourceUrl,
        contentType: resourceKind,
        alt: file.name || 'upload',
      },
    ],
  })
  const createErrors = createdJson?.data?.fileCreate?.userErrors
  if (createErrors?.length) {
    throw new Error(`fileCreate: ${createErrors.map((e) => e.message).join('; ')}`)
  }
  const created0 = createdJson?.data?.fileCreate?.files?.[0]
  if (!created0?.id) throw new Error('fileCreate returned no file')

  // If fileCreate already returned a URL (often the case for direct uploads),
  // skip the polling round-trip and use it.
  const immediateUrl = created0?.url || created0?.image?.url
  if (immediateUrl) return immediateUrl

  return pollFileUntilReady(admin, created0.id)
}

async function pollFileUntilReady(admin, fileId, { tries = 6, delayMs = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const json = await executeGraphQL(admin, QUERY_FILE_BY_ID, { id: fileId })
    const node = json?.data?.node
    const status = node?.fileStatus
    const url = node?.url || node?.image?.url

    if (url) return url
    if (status === 'FAILED') throw new Error('File processing failed')

    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error('File not READY after timeout')
}
