// ApiService — wraps every fetch() this checkout extension makes to our
// ns-retail app backend. The app URL is NOT hardcoded; it's read at
// runtime from a SHOP metafield ($app:cdo / app_url) that the admin app
// writes on every load (see app/routes/app.jsx → syncAppUrlMetafield).
//
// Wiring (one-time setup):
//   1. app.jsx loader → metafieldsSet upserts $app:cdo / app_url
//   2. shopify.extension.toml [[extensions.metafields]] subscribes
//   3. shopify.appMetafields.value exposes it to this file
//
// If the admin app has never been opened on this shop, the metafield is
// empty → getAppBaseUrl() throws a descriptive error so the extension
// UI can show "App not configured" rather than a generic network error.

const METAFIELD_KEY = 'app_url';

function getAppBaseUrl() {
  const list = (typeof shopify !== 'undefined' && shopify?.appMetafields?.value) || [];
  // Shopify resolves $app:cdo at runtime to `app--<your-app-id>--cdo`.
  // We match on the key plus any namespace that ends with `cdo`, so both
  // the literal and the resolved forms are accepted.
  //
  // Shape gotcha: the Preact-based checkout-ui-extension API exposes
  // metafields FLAT — `{ namespace, key, value }` directly. The older
  // React-based API wrapped them under `.metafield`. Read both shapes
  // so this works regardless of API version.
  const entry = list.find((m) => {
    const inner = m?.metafield || m;
    const ns = inner?.namespace || '';
    const key = inner?.key || '';
    return (
      key === METAFIELD_KEY &&
      (ns === '$app:cdo' || ns.endsWith('--cdo') || ns.endsWith(':cdo'))
    );
  });
  const inner = entry?.metafield || entry;
  const url = inner?.value;
  if (!url) {
    throw new Error(
      'App URL not configured. Ask the store admin to open the app once in Shopify admin.',
    );
  }
  return String(url).replace(/\/$/, '');
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
};

export default ApiService;
