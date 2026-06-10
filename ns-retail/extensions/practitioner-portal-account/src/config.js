// ─────────────────────────────────────────────────────────────────────────────
// Manual dev override for the portal backend base URL.
//
// `shopify app dev` mints a NEW tunnel URL on every start (trycloudflare rotates
// the hostname each run), and the merchant-set `api_base_url` extension setting
// does NOT auto-update. To avoid re-editing the Customer Account editor every
// session, paste the current tunnel URL here after the dev server prints it,
// then SAVE — the running `shopify app dev` auto-rebuilds the extension and the
// preview picks it up. No editor change needed.
//
//   export const DEV_API_BASE_URL = 'https://abc-123.trycloudflare.com'
//
// PRECEDENCE: when this is a non-empty string it WINS over the merchant-set
// `api_base_url` setting. The setting is still the source of truth in prod.
//
// ⚠️  Leave this EMPTY ('') before deploying to production so the merchant-
//     configured `api_base_url` setting is used. A non-empty value here ships
//     into the bundle and would override the live setting.
// ─────────────────────────────────────────────────────────────────────────────
export const DEV_API_BASE_URL = 'https://springfield-representations-make-permalink.trycloudflare.com'
