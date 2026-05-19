// Centralized environment configuration.
//
// Every integration module reads through this file rather than touching
// process.env directly so that:
//  - required variables are validated at boot (fail fast, not on the 1st webhook)
//  - default values + parsing live in one place
//  - tests can stub a single module

const QBO_BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
}

const QBO_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

// NMI has a separate sandbox host. Account type is fixed at signup — a
// sandbox security key will be REJECTED on the production host with a
// "Sandbox accounts must use sandbox.nmi.com" error, and vice versa.
// If sandbox stops resolving for you, override via NMI_API_URL / NMI_QUERY_URL.
const NMI_BASE_URLS = {
  sandbox: {
    api: 'https://sandbox.nmi.com/api/transact.php',
    query: 'https://sandbox.nmi.com/api/query.php',
  },
  production: {
    api: 'https://secure.nmi.com/api/transact.php',
    query: 'https://secure.nmi.com/api/query.php',
  },
}

function readEnv(key, { required = false, fallback } = {}) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`)
    }
    return fallback
  }
  return raw
}

function readInt(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`)
  }
  return n
}

const qboEnvironment = readEnv('QBO_ENVIRONMENT', { fallback: 'sandbox' })
if (!QBO_BASE_URLS[qboEnvironment]) {
  throw new Error(`QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${qboEnvironment}`)
}

const nmiEnvironment = readEnv('NMI_ENVIRONMENT', { fallback: 'sandbox' })
if (!NMI_BASE_URLS[nmiEnvironment]) {
  throw new Error(`NMI_ENVIRONMENT must be 'sandbox' or 'production', got: ${nmiEnvironment}`)
}

export const config = {
  mongodbUri: readEnv('MONGODB_URI', { required: true }),

  qbo: {
    clientId: readEnv('QBO_CLIENT_ID'),
    clientSecret: readEnv('QBO_CLIENT_SECRET'),
    realmId: readEnv('QBO_REALM_ID'),
    bootstrapRefreshToken: readEnv('QBO_REFRESH_TOKEN'),
    environment: qboEnvironment,
    apiBaseUrl: readEnv('QBO_API_BASE_URL', { fallback: QBO_BASE_URLS[qboEnvironment] }),
    oauthTokenUrl: readEnv('QBO_OAUTH_TOKEN_URL', { fallback: QBO_OAUTH_TOKEN_URL }),
    minorVersion: readEnv('QBO_MINOR_VERSION', { fallback: '73' }),
    defaultItemId: readEnv('QBO_DEFAULT_ITEM_ID', { fallback: '1' }),
  },

  nmi: {
    environment: nmiEnvironment,
    securityKey: readEnv('NMI_SECURITY_KEY'),
    publicKey: readEnv('NMI_PUBLIC_KEY'),
    // Explicit override wins. Otherwise auto-select by environment.
    // NMI rejects cross-environment calls so this has to be right.
    apiUrl: readEnv('NMI_API_URL', { fallback: NMI_BASE_URLS[nmiEnvironment].api }),
    queryUrl: readEnv('NMI_QUERY_URL', { fallback: NMI_BASE_URLS[nmiEnvironment].query }),
    // Dev/sandbox-only static test card. Resolved at boot, used by the
    // paymentDetailsResolver when no real card is available. Production
    // ignores these even if set — see assertSafeTestCardConfig().
    testCard: {
      ccnumber: readEnv('NMI_TEST_CCNUMBER'),
      ccexp: readEnv('NMI_TEST_CCEXP'),
      cvv: readEnv('NMI_TEST_CVV'),
    },
  },

  payments: {
    maxRetryAttempts: readInt('PAYMENT_MAX_RETRY_ATTEMPTS', 6),
    scheduleTimezone: readEnv('PAYMENT_SCHEDULE_TZ', { fallback: 'America/Los_Angeles' }),
    // Production cron expressions for the retry ticks. Defaults are
    // 00:30 on the 15th and 00:30 on the last day of the month.
    retryCronPrimary: readEnv('PAYMENT_RETRY_CRON_PRIMARY', { fallback: '30 0 15 * *' }),
    retryCronSecondary: readEnv('PAYMENT_RETRY_CRON_SECONDARY', { fallback: '30 0 L * *' }),
    // Dev-only override. When set, replaces the cron expressions with
    // an Agenda "every <interval>" schedule. Examples:
    //   PAYMENT_RETRY_INTERVAL=1 minute
    //   PAYMENT_RETRY_INTERVAL=30 seconds
    // Leave unset in production.
    retryIntervalOverride: readEnv('PAYMENT_RETRY_INTERVAL'),
    // If true, attempt NMI charge immediately after creating the QBO
    // invoice. If the charge fails/declines, invoice stays pending and
    // the scheduler picks it up. Set false to defer all charges to the
    // scheduler.
    chargeImmediately: readEnv('PAYMENT_CHARGE_IMMEDIATELY', { fallback: 'false' }) === 'true',
    // HTTP-level retry tuning (used by QBO + NMI HTTP clients).
    httpRetryAttempts: readInt('HTTP_RETRY_ATTEMPTS', 4),
    httpRetryBaseMs: readInt('HTTP_RETRY_BASE_MS', 500),
    httpRetryMaxMs: readInt('HTTP_RETRY_MAX_MS', 4000),
  },

  logging: {
    pretty: readEnv('LOG_PRETTY', { fallback: 'false' }) === 'true',
    level: readEnv('LOG_LEVEL', { fallback: 'info' }),
  },

  shopify: {
    appUrl: readEnv('SHOPIFY_APP_URL', { fallback: '' }),
  },
}

// Convenience: integrations check this at call sites so we never silently
// run with placeholder credentials.
export function assertQboConfigured() {
  const missing = ['clientId', 'clientSecret', 'realmId', 'bootstrapRefreshToken']
    .filter((k) => !config.qbo[k])
  if (missing.length) {
    throw new Error(`QBO not configured. Missing: ${missing.map((k) => `QBO_${k}`).join(', ')}`)
  }
}

export function assertNmiConfigured() {
  if (!config.nmi.securityKey) {
    throw new Error('NMI not configured. Missing NMI_SECURITY_KEY')
  }
}

// Hard guard so a stray NMI_TEST_* in a prod .env can't be silently picked
// up. Logs a loud warning and clears the values so resolver returns null.
export function assertSafeTestCardConfig() {
  const hasTestCard = Boolean(config.nmi.testCard.ccnumber || config.nmi.testCard.ccexp)
  if (!hasTestCard) return
  if (config.nmi.environment !== 'sandbox') {
    console.warn(
      '\n[config] WARNING: NMI_TEST_CCNUMBER / NMI_TEST_CCEXP are set but ' +
        `NMI_ENVIRONMENT=${config.nmi.environment}. Refusing to use test card ` +
        'in non-sandbox env. Unset the test vars or set NMI_ENVIRONMENT=sandbox.\n',
    )
    config.nmi.testCard = { ccnumber: null, ccexp: null, cvv: null }
  }
}
