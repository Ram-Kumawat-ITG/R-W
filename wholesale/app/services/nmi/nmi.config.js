// NMI gateway configuration.
//
// NMI splits the API between sandbox.nmi.com and secure.nmi.com hosts and
// rejects cross-environment calls. NMI_ENVIRONMENT must match the security
// key — sandbox key against production host returns "Authentication Failed".

import { readEnv } from '../../utils/env.utils'
import { NMI_BASE_URLS } from './nmi.constants'

const nmiEnvironment = readEnv('NMI_ENVIRONMENT', { fallback: 'sandbox' })
if (!NMI_BASE_URLS[nmiEnvironment]) {
  throw new Error(`NMI_ENVIRONMENT must be 'sandbox' or 'production', got: ${nmiEnvironment}`)
}

export const nmiConfig = {
  environment: nmiEnvironment,
  securityKey: readEnv('NMI_SECURITY_KEY'),
  publicKey: readEnv('NMI_PUBLIC_KEY'),
  // Explicit URL overrides win if set. Otherwise auto-select by environment.
  apiUrl: readEnv('NMI_API_URL', { fallback: NMI_BASE_URLS[nmiEnvironment].api }),
  queryUrl: readEnv('NMI_QUERY_URL', { fallback: NMI_BASE_URLS[nmiEnvironment].query }),
  // Sandbox-only static test card. Resolved at boot. Production env scrubs
  // these values via assertSafeTestCardConfig() if accidentally set.
  testCard: {
    ccnumber: readEnv('NMI_TEST_CCNUMBER'),
    ccexp: readEnv('NMI_TEST_CCEXP'),
    cvv: readEnv('NMI_TEST_CVV'),
  },
}

export function assertNmiConfigured() {
  if (!nmiConfig.securityKey) {
    throw new Error('NMI not configured. Missing NMI_SECURITY_KEY')
  }
}

// Hard guard so a stray NMI_TEST_* in a prod .env can't be silently picked
// up. Logs a loud warning and clears the values so resolver returns null.
// Called from entry.server.jsx at boot.
export function assertSafeTestCardConfig() {
  const hasTestCard = Boolean(nmiConfig.testCard.ccnumber || nmiConfig.testCard.ccexp)
  if (!hasTestCard) return
  if (nmiConfig.environment !== 'sandbox') {
    console.warn(
      '\n[config] WARNING: NMI_TEST_CCNUMBER / NMI_TEST_CCEXP are set but ' +
        `NMI_ENVIRONMENT=${nmiConfig.environment}. Refusing to use test card ` +
        'in non-sandbox env. Unset the test vars or set NMI_ENVIRONMENT=sandbox.\n',
    )
    nmiConfig.testCard = { ccnumber: null, ccexp: null, cvv: null }
  }
}
