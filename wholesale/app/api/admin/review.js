import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { sendResponse } from '../../services/APIService/api.service'
import { updateCustomerTags as customerUpdateTags, sendCustomerInvite as customerSendInvite } from '../../services/shopify/shopify.service'
import { replayPendingOrdersForCustomer } from '../../services/order/order.service'

// POST /api/admin/customers/:id/review
// Flips the customer from Pending to Approved: swaps the Shopify tag,
// sends the activation/approved email, and stamps reviewedAt on the Mongo doc.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let admin
  let session
  try {
    const auth = await authenticate.admin(request)
    admin = auth.admin
    session = auth.session
  } catch (e) {
    console.error('[admin/review] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid id', null)
  }

  await connectDB()

  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Not found', null)

  // Step 1 — swap Shopify tag from Pending → Approved (only if customer exists)
  if (doc.customerId) {
    try {
      await customerUpdateTags(admin, {
        customerId: doc.customerId,
        addTag: 'Reviewed',
        removeTag: 'Un-reviewed',
      })
    } catch (e) {
      console.error('[admin/review] customerUpdateTags failed:', e?.message || e)
      return sendResponse(502, 'error', 'Failed to update Shopify customer', {
        detail: e?.message || String(e),
      })
    }

    // Step 2 — send the "approved / activate" email
    try {
      await customerSendInvite(admin, {
        customerId: doc.customerId,
        subject: 'Your wholesale account has been approved',
        message:
          'Welcome to Natural Solutions Wholesale! Your application has been approved. Click the activation link below to set your password and start shopping at wholesale pricing.',
      })
    } catch (e) {
      console.error('[admin/review] customerSendInvite failed:', e?.message || e)
      // Don't fail the review just because the email failed — log it and move on.
    }
  }

  // Step 3 — persist review state on the Mongo doc
  try {
    await WholesaleApplication.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: 'approved',
          reviewedAt: new Date(),
          customerInviteSentAt: new Date(),
        },
      }
    )
  } catch (e) {
    console.error('[admin/review] mongo update failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to save review state', {
      detail: e?.message || String(e),
    })
  }

  // Step 4 — fire-and-forget: replay any orders that were held in
  // `pending_approval` waiting for this customer's approval. Non-blocking
  // so the admin sees the success response immediately while N orders
  // process in the background. Per-order failures are caught inside the
  // replay helper and surfaced via the order doc's `processingError`.
  const shop = session?.shop
  if (shop && doc.email) {
    Promise.resolve()
      .then(() => replayPendingOrdersForCustomer({ shop, email: doc.email }))
      .then((summary) => {
        console.log(
          `[admin/review] replay for ${doc.email} → ` +
            `total=${summary.total} processed=${summary.processed} ` +
            `failed=${summary.failed} skipped=${summary.skipped}`,
        )
      })
      .catch((err) => {
        console.error(`[admin/review] replay threw unexpectedly: ${err?.message || err}`)
      })
  } else {
    console.warn('[admin/review] cannot replay pending orders — missing shop or email on application')
  }

  return sendResponse(200, 'success', 'Customer approved', { id })
}
