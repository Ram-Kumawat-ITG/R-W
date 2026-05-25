import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { sendResponse } from '../../services/APIService/api.service'
import { updateCustomerTags as customerUpdateTags } from '../../services/shopify/shopify.service'

// POST /api/admin/customers/:id/unreview
// Reverts an approved customer back to Pending. Swaps the Shopify tag and
// clears reviewedAt on the Mongo doc. No email is sent.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let admin
  try {
    const auth = await authenticate.admin(request)
    admin = auth.admin
  } catch (e) {
    console.error('[admin/unreview] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid id', null)
  }

  await connectDB()

  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Not found', null)

  if (doc.customerId) {
    try {
      await customerUpdateTags(admin, {
        customerId: doc.customerId,
        addTag: 'Un-reviewed',
        removeTag: 'Reviewed',
      })
    } catch (e) {
      console.error('[admin/unreview] customerUpdateTags failed:', e?.message || e)
      return sendResponse(502, 'error', 'Failed to update Shopify customer', {
        detail: e?.message || String(e),
      })
    }
  }

  try {
    await WholesaleApplication.updateOne(
      { _id: doc._id },
      { $set: { status: 'pending', reviewedAt: null } }
    )
  } catch (e) {
    console.error('[admin/unreview] mongo update failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to save review state', {
      detail: e?.message || String(e),
    })
  }

  return sendResponse(200, 'success', 'Customer moved back to pending', { id })
}
