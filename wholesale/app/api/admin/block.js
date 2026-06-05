import mongoose from 'mongoose'
import { authenticate } from '../../shopify.server'
import connectDB from '../../services/APIService/mongo.service'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { sendResponse } from '../../services/APIService/api.service'

// POST /api/admin/customers/:id/block
//
// Soft-block a wholesale customer. Does NOT delete anything:
//   - On Shopify customer: removes "Approved" tag, adds "Blocked" tag
//   - On Mongo doc:        status = 'blocked', blockedAt = now
//
// Idempotent — calling it twice is safe (no-op on second call).
export async function action({ request, params }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let admin
  try {
    const auth = await authenticate.admin(request)
    admin = auth.admin
  } catch (e) {
    console.error('[admin/block] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const { id } = params
  if (!id || !mongoose.isValidObjectId(id)) {
    return sendResponse(400, 'error', 'Invalid id', null)
  }

  await connectDB()
  const doc = await WholesaleApplication.findById(id)
  if (!doc) return sendResponse(404, 'error', 'Not found', null)
  if (!doc.customerId) {
    return sendResponse(400, 'error', 'No Shopify customer linked', null)
  }

  // 1) Flip the Shopify customer's tags: remove "Approved", add "Blocked"
  try {
    const fetchRes = await admin.graphql(
      `query GetTags($id: ID!) { customer(id: $id) { tags } }`,
      { variables: { id: doc.customerId } },
    )
    const fetchData = await fetchRes.json()
    const existing = fetchData?.data?.customer?.tags || []

    const next = existing.filter((t) => t !== 'Approved')
    if (!next.includes('Blocked')) next.push('Blocked')

    const updRes = await admin.graphql(
      `mutation TagCustomer($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }`,
      { variables: { input: { id: doc.customerId, tags: next } } },
    )
    const updData = await updRes.json()
    const errs = updData?.data?.customerUpdate?.userErrors || []
    if (errs.length) {
      throw new Error(errs.map((e) => e.message).join('; '))
    }
  } catch (e) {
    console.error('[admin/block] tag update failed:', e?.message || e)
    return sendResponse(502, 'error', 'Failed to update Shopify customer tags', {
      detail: e?.message || String(e),
    })
  }

  // 2) Soft-block in Mongo
  try {
    await WholesaleApplication.updateOne(
      { _id: doc._id },
      { $set: { status: 'blocked', blockedAt: new Date() } },
    )
  } catch (e) {
    console.error('[admin/block] mongo update failed:', e?.message || e)
    return sendResponse(500, 'error', 'Failed to update application', {
      detail: e?.message || String(e),
    })
  }

  return sendResponse(200, 'success', 'Customer blocked', { id })
}
