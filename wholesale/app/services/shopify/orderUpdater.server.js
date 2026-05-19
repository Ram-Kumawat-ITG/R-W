import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../logger.server'
import { PermanentError, TransientError } from '../retry.server'

const log = createLogger('shopify.order_updater')

// Build an Admin GraphQL client for a shop without an active request.
// `unauthenticated.admin(shop)` is the package-provided helper that
// loads the merchant's offline session from MongoDB and returns
// `{ admin, session }` — same admin shape used inside loaders/actions.
async function adminForShop(shop) {
  try {
    const { admin, session } = await unauthenticated.admin(shop)
    return { admin, session }
  } catch (err) {
    // Most common: no installed session for this shop (app uninstalled
    // or never installed).
    throw new PermanentError(
      `No installed session for shop ${shop} — re-install the app. (${err.message})`,
      { cause: err },
    )
  }
}

function toOrderGid(orderId) {
  return String(orderId).startsWith('gid://')
    ? String(orderId)
    : `gid://shopify/Order/${orderId}`
}

// Marks a Shopify order as paid. Returns the order's new
// displayFinancialStatus on success ("PAID"). Idempotent — Shopify will
// return a userError ("This order has already been paid") on the second
// call which we treat as success.
export async function markShopifyOrderPaid({ shop, shopifyOrderId }) {
  if (!shop || !shopifyOrderId) {
    throw new Error('markShopifyOrderPaid: shop and shopifyOrderId are required')
  }

  console.log(`[shopify] markShopifyOrderPaid shop=${shop} order=${shopifyOrderId}`)
  log.info('mark_paid.request', { shop, shopifyOrderId })

  const { admin } = await adminForShop(shop)
  const gid = toOrderGid(shopifyOrderId)

  let json
  try {
    const response = await admin.graphql(
      `#graphql
      mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id
            displayFinancialStatus
            updatedAt
          }
          userErrors { field message }
        }
      }`,
      { variables: { input: { id: gid } } },
    )
    json = await response.json()
  } catch (err) {
    // Network / 5xx on the Admin API → transient, let upstream retry.
    console.error(`[shopify] orderMarkAsPaid threw: ${err.message}`)
    throw new TransientError(`Shopify orderMarkAsPaid threw: ${err.message}`, { cause: err })
  }

  const data = json?.data?.orderMarkAsPaid
  const userErrors = data?.userErrors || []

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
