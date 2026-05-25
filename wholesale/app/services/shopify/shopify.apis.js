// Low-level Shopify Admin GraphQL plumbing.
//
// The `admin` client itself is constructed by either
// `authenticate.admin(request)` (inside a loader/action with a live
// session) or `unauthenticated.admin(shop)` (background jobs, scheduler).
// This file wraps both with consistent error handling so callers don't
// have to translate the package-specific exception shapes themselves.

import { unauthenticated, apiVersion } from '../../shopify.server'
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

// REST POST helper. The Shopify Admin GraphQL API doesn't expose a clean
// "record an arbitrary manual payment transaction" mutation — the
// closest is orderCapture which requires a pre-existing AUTHORIZATION
// transaction (our wholesale orders never carry one). Falling back to
// REST is the documented path for partial-payment mirroring on
// externally-captured orders.
//
// Path looks like "/orders/12345/transactions.json". We prepend the
// versioned admin host so callers stay endpoint-only.
//
// Returns the parsed JSON body. 4xx/5xx surface as classified errors
// (PermanentError vs TransientError) so the retry layer can do the
// right thing.
export async function shopifyRestPost({ shop, session, path, body }) {
  if (!shop) throw new Error('shopifyRestPost: shop is required')
  if (!path || !path.startsWith('/')) {
    throw new Error('shopifyRestPost: path must start with "/"')
  }
  const accessToken = session?.accessToken
  if (!accessToken) {
    throw new PermanentError(
      `shopifyRestPost: no access token on the session for ${shop}`,
    )
  }
  const url = `https://${shop}/admin/api/${apiVersion}${path}`

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    log.warn('rest.transient', { url, err })
    throw new TransientError(`Shopify REST POST threw: ${err.message}`, {
      cause: err,
    })
  }
  const text = await res.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON error response */
    }
  }
  if (res.status >= 500) {
    throw new TransientError(`Shopify REST ${url} → ${res.status}`, {
      status: res.status,
      body: text,
    })
  }
  if (!res.ok) {
    throw new PermanentError(`Shopify REST ${url} → ${res.status}: ${text}`, {
      status: res.status,
      body: text,
    })
  }
  return json
}
