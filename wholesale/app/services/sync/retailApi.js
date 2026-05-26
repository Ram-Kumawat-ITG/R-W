import { syncConfig } from './sync.config'

// Lightweight fetch wrapper for the retail store's Admin REST API.
// GraphQL is used for wholesale (via the Shopify app session), but REST
// is simpler here since we hold a direct access token for retail.
async function call(path, { method = 'GET', body } = {}) {
  const { retailShop, retailAccessToken, apiVersion } = syncConfig
  const url = `https://${retailShop}/admin/api/${apiVersion}/${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': retailAccessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Retail API ${method} /${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json') || res.status === 204) return null
  return res.json()
}

export const retailClient = {
  get: (path) => call(path),
  post: (path, body) => call(path, { method: 'POST', body }),
  put: (path, body) => call(path, { method: 'PUT', body }),
  delete: (path) => call(path, { method: 'DELETE' }),
}
