import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import { sendResponse } from '../../services/APIService/api.service'
import { reconcileRetailPrices } from '../../services/sync/retailPriceReconcile.service'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('api.admin.sync_retail_prices')

// POST /api/admin/sync/retail-prices
//
// Runs the retail-price reconcile sweep ON DEMAND — the same operation the
// `reconcile-retail-prices` CRON performs on its schedule. Exists because
// Shopify sends NO webhook when only a VARIANT metafield changes, so an edit to
// a wholesale variant's "Retail price" (`custom.retail_price`) has no push path
// to the retail store; without this button a merchant would have to wait for the
// next tick. See services/sync/retailPriceReconcile.service.js.
//
// Body (all optional):
//   { dryRun: true }              — detect + report drift, write NOTHING
//   { productIds: ["123", ...] }  — restrict to specific wholesale product ids
//
// Safe to call repeatedly: the sweep only writes variants whose retail price
// actually differs from the last-known value, and only their price /
// compare_at_price. A second call right after is a no-op.
//
// Runs synchronously (the caller wants the result). The sweep is a paged
// GraphQL read plus one PUT per drifted product, so it is not open-ended —
// but for a very large catalog the request can take a while, which is why the
// UI disables the button while it is in flight.
export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session
  try {
    const auth = await authenticate.admin(request)
    session = auth.session
  } catch (e) {
    console.error('[admin/sync-retail-prices] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  let dryRun = false
  let productIds = null
  try {
    const body = await request.clone().json()
    dryRun = Boolean(body?.dryRun)
    if (Array.isArray(body?.productIds) && body.productIds.length > 0) {
      productIds = body.productIds.map((id) => String(id).trim()).filter(Boolean)
    }
  } catch {
    // No body / non-JSON body — run a full apply sweep.
  }

  await connectDB()

  const initiatedBy = session.onlineAccessInfo?.associated_user?.email || session.shop
  log.info('request', { shop: session.shop, by: initiatedBy, dryRun, productIds })

  let summary
  try {
    // The shop is taken from the authenticated session rather than config, so
    // the button always reconciles the store the admin is actually in.
    summary = await reconcileRetailPrices({ shop: session.shop, dryRun, productIds })
  } catch (err) {
    // reconcileRetailPrices is written not to throw; this is belt-and-braces so
    // an unexpected failure returns JSON rather than a 500 HTML page.
    log.error('failed', { err: err?.message || String(err) })
    return sendResponse(502, 'error', err?.message || 'Retail price sync failed', null)
  }

  if (summary.skipped) {
    const reasons = {
      sync_disabled: 'Retail sync is not configured (RETAIL_SHOP_DOMAIN / RETAIL_ADMIN_ACCESS_TOKEN).',
      no_shop: 'Could not resolve the wholesale shop domain.',
      no_session: 'No stored Shopify session for this shop — reinstall/authenticate the app.',
      fetch_failed: `Could not read products from Shopify: ${summary.error || 'unknown error'}`,
    }
    return sendResponse(409, 'error', reasons[summary.reason] || `Skipped: ${summary.reason}`, summary)
  }

  const message = summary.dryRun
    ? `Checked ${summary.variantsChecked} variant(s) — ${summary.variantsDrifted} out of sync (nothing written).`
    : summary.variantsUpdated > 0
      ? `Updated ${summary.variantsUpdated} variant price(s) on the retail store.`
      : 'All retail prices already up to date.'

  log.info('done', { shop: session.shop, by: initiatedBy, ...summary, changes: undefined })
  return sendResponse(200, 'success', message, summary)
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}
