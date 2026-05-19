import mongoose from 'mongoose'
import { authenticate } from '../shopify.server'
import connectDB from '../db.server'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../utils/sendResponse'
import { buildShopifyNote } from '../utils/buildShopifyNote'

// GET /api/admin/customers/:id
// Returns the single application + the reconstructed Shopify note so the
// detail page can show what was synced.
export async function loader({ request, params }) {
  try {
    await authenticate.admin(request)
  } catch (e) {
    console.error('[admin/customer] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid id', null)
  }

  await connectDB()

  try {
    const doc = await WholesaleApplication.findById(id).lean()
    if (!doc) return sendResponse(404, 'error', 'Not found', null)

    const application = {
      ...doc,
      _id: doc._id.toString(),
    }
    // Reconstruct the same note the backend sent to Shopify.
    const shopifyNote = buildShopifyNote(application)

    return sendResponse(200, 'success', 'OK', {
      application,
      shopifyNote,
    })
  } catch (e) {
    console.error('[admin/customer] query failed:', e)
    return sendResponse(500, 'error', 'Failed to load customer', { detail: e.message })
  }
}
