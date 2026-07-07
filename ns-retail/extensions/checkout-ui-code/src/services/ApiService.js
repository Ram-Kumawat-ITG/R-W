// ApiService — wraps every fetch() this checkout extension makes to our
// ns-retail app backend.
//
// URL sourcing (2026-07-02): reads through the shared FullPageApi module
// at extensions/services/FullPageApi.jsx, which has `SHOPIFY_APP_URL`
// baked in at BUILD time (esbuild substitutes process.env.SHOPIFY_APP_URL
// from the app's .env before bundling). Same pattern the other ns-retail
// UI extensions (processing-fee, practitioner-portal-account) already use.
//
// Previous impl (removed) read the base URL from a shop metafield
// ($app:cdo / app_url) that the admin app wrote on every load; that
// required (a) the admin app to have been opened once, (b) a metafield
// subscription in shopify.extension.toml, and (c) shape-tolerant parsing
// of the $app:cdo namespace. All redundant now — the build-time constant
// is set at deploy time from the same env value.

import FullPageApi from '../../../services/FullPageApi.jsx';

function getAppBaseUrl() {
  const url = FullPageApi.getAppBaseUrl();
  if (!url) {
    throw new Error(
      'App URL not configured. Set SHOPIFY_APP_URL in the ns-retail app .env and redeploy the extension.',
    );
  }
  return url;
}

async function jsonPost(path, body) {
  const baseUrl = getAppBaseUrl();
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response (rare). Use status to build the error.
  }

  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.responseData = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const ApiService = {
  // POST /api/cdo/checkout-validate-code
  // `identity` carries the buyer's email + Shopify customer id so the backend
  // can enforce the permanent patient↔practitioner binding (a patient may only
  // use codes from the practitioner they're already associated with). Both are
  // best-effort — omitted when not available (guest checkout / no PCD email).
  // Returns { valid, reason?, message?, code?, practitionerName?, discountPercent? }
  async verifyCode(code, identity = {}) {
    const data = await jsonPost('/api/cdo/checkout-validate-code', {
      code,
      email: identity.email || undefined,
      customerId: identity.customerId || undefined,
    });
    return data?.result || { valid: false };
  },

  // POST /api/cdo/checkout-find-by-customer-id
  // For LOGGED-IN customers. Checkout extension can't read customer.tags
  // directly (known Shopify limitation), so we hand the customer GID +
  // shop domain to our backend, which queries the customer's tags via
  // Shopify Admin GraphQL and extracts the `code:*` tag.
  // Returns { found: boolean, code?, practitionerName?, discountPercent? }
  async findByCustomerId(
    /** @type {string} */ customerId,
    /** @type {string} */ shop,
  ) {
    const data = await jsonPost('/api/cdo/checkout-find-by-customer-id', {
      customerId,
      shop,
    });
    return data?.result || { found: false };
  },

  // POST /api/cdo/checkout-apply-code
  // When a customer applies a referral code, immediately tag the Shopify
  // customer so the code becomes the default for future orders. This is
  // fire-and-forget (non-blocking) — tag sync failure doesn't affect checkout.
  // Returns { ok, tagged, code?, practitionerName?, discountPercent? }
  async applyAndTagCode(code, identity = {}, shop = '') {
    try {
      const data = await jsonPost('/api/cdo/checkout-apply-code', {
        code,
        email: identity.email || undefined,
        customerId: identity.customerId || undefined,
        shopifyCustomerId: identity.shopifyCustomerId || undefined,
        shopifyShop: shop || undefined,
      });
      return data?.result || { ok: false, tagged: false };
    } catch (err) {
      console.warn('[ApiService.applyAndTagCode] failed:', err?.message);
      // Non-blocking: return a falsy result but don't throw
      return { ok: false, tagged: false };
    }
  },
};

export default ApiService;
