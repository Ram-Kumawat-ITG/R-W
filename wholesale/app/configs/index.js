// Top-level config aggregator.
//
// Each service owns its own config file (services/<svc>/<svc>.config.js).
// This file is for boot-time validation — entry.server.jsx imports
// assertAllConfigured() to run every service's assertion in one place.
//
// Day-to-day, code should import from the specific service config it
// needs — not from this aggregator — so dependencies stay explicit.

import { qboConfig, assertQboConfigured } from '../services/qbo/qbo.config'
import { nmiConfig, assertNmiConfigured, assertSafeTestCardConfig } from '../services/nmi/nmi.config'
import { paymentConfig } from '../services/payment/payment.config'
import { schedulerConfig } from '../services/scheduler/scheduler.config'
import { shopifyConfig } from '../services/shopify/shopify.config'
import { emailConfig, assertEmailConfigured } from '../services/email/email.config'

// Boot-time safety: scrub test cards if env mismatched. Non-fatal.
export function assertSafeBootConfig() {
  assertSafeTestCardConfig()
}

// Use at the actual call site rather than at boot — services may go
// uncalled for a session and we don't want to refuse to start just
// because (e.g.) QBO env is missing on a non-billing day.
export { assertQboConfigured, assertNmiConfigured, assertEmailConfigured }

// Re-exports so callers can pull individual configs from one place if
// preferred. The direct-import path (../services/qbo/qbo.config) is
// equally valid and keeps coupling explicit.
export { qboConfig, nmiConfig, paymentConfig, schedulerConfig, shopifyConfig, emailConfig }
