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
  const entry = list.find((m) => {
    const ns = m?.metafield?.namespace || '';
    const key = m?.metafield?.key || '';
    return (
      key === METAFIELD_KEY &&
      (ns === '$app:cdo' || ns.endsWith('--cdo') || ns.endsWith(':cdo'))
    );
  });
  const url = entry?.metafield?.value;
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
  // Returns { valid: boolean, code?, practitionerName?, discountPercent? }
  async verifyCode(code) {
    const data = await jsonPost('/api/cdo/checkout-validate-code', { code });
    return data?.result || { valid: false };
  },
};

export default ApiService;
