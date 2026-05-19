// Low-level Shopify Admin GraphQL plumbing.
//
// The `admin` client itself is constructed by either
// `authenticate.admin(request)` (inside a loader/action with a live
// session) or `unauthenticated.admin(shop)` (background jobs, scheduler).
// This file wraps both with consistent error handling so callers don't
// have to translate the package-specific exception shapes themselves.

import { unauthenticated } from '../../shopify.server'
import { createLogger } from '../../utils/logger.utils'
import { PermanentError, TransientError } from '../../utils/retry.utils'

const log = createLogger('shopify.apis')

// Get an Admin GraphQL client for a shop WITHOUT an active request.
// Loads the merchant's offline session from MongoDB and returns
// `{ admin, session }` — same shape as inside loaders/actions.
//
// Throws PermanentError if the shop has no installed session (app
// uninstalled or never installed). Schedulers should catch this and
// continue without blocking on the missing shop.
export async function getUnauthenticatedAdmin(shop) {
  try {
    const { admin, session } = await unauthenticated.admin(shop)
    return { admin, session }
  } catch (err) {
    throw new PermanentError(
      `No installed session for shop ${shop} — re-install the app. (${err.message})`,
      { cause: err },
    )
  }
}

// Execute a GraphQL operation and parse the JSON envelope. Returns the
// parsed `data` block (or null) plus the userErrors array surfaced by
// most Shopify mutations.
//
// Network and 5xx errors are classified as TransientError so retry
// wrappers will back off. User errors are NOT thrown — callers decide
// how to interpret them (some mutations return "already paid" which we
// treat as success).
export async function executeGraphQL(admin, operation, variables) {
  let res
  try {
    res = await admin.graphql(operation, variables ? { variables } : undefined)
  } catch (err) {
    log.warn('graphql.transient', { err })
    throw new TransientError(`Shopify Admin GraphQL threw: ${err.message}`, { cause: err })
  }
  const json = await res.json()
  return json
}

// Convenience for callers that just want the data + any userErrors at a
// specific top-level mutation key. e.g.:
//   executeMutation(admin, MUTATION_X, vars, 'someMutation')
//     → { data, userErrors }
export async function executeMutation(admin, operation, variables, mutationKey) {
  const json = await executeGraphQL(admin, operation, variables)
  const block = json?.data?.[mutationKey]
  return {
    data: block,
    userErrors: block?.userErrors || [],
    raw: json,
  }
}
