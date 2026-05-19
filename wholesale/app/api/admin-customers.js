import { authenticate } from '../shopify.server'
import connectDB from '../db.server'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../utils/sendResponse'

// GET /api/admin/customers?search=&status=
// Returns a paginated list of applications for the embedded admin dashboard.
export async function loader({ request }) {
  try {
    await authenticate.admin(request)
  } catch (e) {
    console.error('[admin/customers] auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  const url = new URL(request.url)
  const search = (url.searchParams.get('search') || '').trim()
  const status = (url.searchParams.get('status') || '').trim()
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)))

  await connectDB()

  const query = {}
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    query.$or = [{ firstName: re }, { lastName: re }, { email: re }]
  }
  if (status === 'approved') {
    query.shopifyCreateFailed = { $ne: true }
    query.customerId = { $ne: null }
  } else if (status === 'sync-failed') {
    query.shopifyCreateFailed = true
  }

  const skip = (page - 1) * limit

  try {
    const [rows, total] = await Promise.all([
      WholesaleApplication.find(query)
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('firstName lastName email submittedAt credentials customerId shopifyCreateFailed shopifyCreateError')
        .lean(),
      WholesaleApplication.countDocuments(query),
    ])
    return sendResponse(200, 'success', 'OK', {
      rows: rows.map((r) => ({
        id: r._id.toString(),
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        submittedAt: r.submittedAt,
        credentials: r.credentials,
        customerId: r.customerId,
        shopifyCreateFailed: Boolean(r.shopifyCreateFailed),
      })),
      total,
      page,
      limit,
    })
  } catch (e) {
    console.error('[admin/customers] query failed:', e)
    return sendResponse(500, 'error', 'Failed to load customers', { detail: e.message })
  }
}
