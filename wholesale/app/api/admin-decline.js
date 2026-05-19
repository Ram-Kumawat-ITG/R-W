import mongoose from 'mongoose'
import { authenticate } from '../shopify.server'
import connectDB from '../services/APIService/mongo.service'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../services/APIService/api.service'
import { sendCustomerInvite as customerSendInvite, deleteCustomer as customerDelete } from '../services/shopify/shopify.service'

// POST /api/admin/customers/:id/decline
// Cascading decline: send a final email, delete in Shopify, delete from Mongo.
// If any step fails the Mongo doc stays so the admin can retry.
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let admin
  try {
    const auth = await authenticate.admin(request)
    admin = auth.admin
  } catch (e) {
    console.error('[admin/decline] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid id', null)
  }

  await connectDB()

  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Not found', null)

  // Step 1 — send the decline email (only if the Shopify customer exists).
  // We send BEFORE delete because customerSendInvite requires the customer to
  // still be in Shopify.
  if (doc.customerId) {
    try {
      await customerSendInvite(admin, {
        customerId: doc.customerId,
        subject: 'About your wholesale application',
        message:
          "Thank you for your interest in our wholesale program. After reviewing your application we're unable to approve it at this time. If you have questions please reply to this email. — Natural Solutions Wholesale",
      })
    } catch (e) {
      console.error('[admin/decline] decline email failed:', e?.message || e)
      // Continue to delete steps — email failure should not block decline.
    }
  }

  // Step 2 — delete the Shopify customer.
  if (doc.customerId) {
    try {
      await customerDelete(admin, doc.customerId)
    } catch (e) {
      console.error('[admin/decline] customerDelete failed:', e?.message || e)
      return sendResponse(502, 'error', 'Failed to delete Shopify customer', {
        detail: e?.message || String(e),
      })
    }
  }

  // Step 3 — delete the Mongo document.
  try {
    await WholesaleApplication.deleteOne({ _id: doc._id })
  } catch (e) {
    console.error('[admin/decline] mongo delete failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to delete application', {
      detail: e?.message || String(e),
    })
  }

  return sendResponse(200, 'success', 'Customer declined and removed', { id })
}
