// Customer service — ensure a Shopify customer is mapped to a QBO
// customer and an NMI customer vault. The cross-system mapping lives in
// customer_maps (one row per (shop, email)).

import CustomerMap from '../../models/customerMap.server'
import WholesaleApplication from '../../models/wholesaleApplication.server'
import { findOrCreateCustomer as findOrCreateQboCustomer } from '../qbo/qbo.service'
import { validateCustomerVault } from '../nmi/nmi.service'
import {
  buildProfileFromShopifyOrder,
  missingBillingFields,
  formatAddress,
  normalizePaymentMethod,
} from './customer.utils'
import { createLogger } from '../../utils/logger.utils'
import { notifyQboCustomerSyncFailed } from '../notifications/qboAlertNotification.service'

const log = createLogger('customer.service')

// Ensure the customer exists in QBO and that the NMI customer vault
// captured at registration time is mirrored onto the local mapping.
//
// Vault sourcing: the NMI Customer Vault is created exactly once, at
// registration submit (see app/api/registration-form.js). The vault id
// is persisted on `wholesale_applications.nmiCustomerVaultId`. This
// service no longer creates vaults — it copies the id forward and runs
// a `validateCustomerVault` pre-flight against NMI so downstream charge
// paths can trust whatever lands on `CustomerMap.nmiCustomerVaultId`.
export async function ensureCustomerForOrder({ shop, order }) {
  const profile = buildProfileFromShopifyOrder(order)
  console.log(`[customers] ensureCustomerForOrder(shop=${shop}, email=${profile.email})`)
  console.log(`[customers] resolved profile:`)
  console.log(`              name      : ${profile.firstName} ${profile.lastName}`)
  console.log(`              company   : ${profile.companyName || '(none)'}`)
  console.log(`              phone     : ${profile.phone || '(none)'}`)
  console.log(`              billing   : ${formatAddress(profile.billingAddress)}`)
  console.log(`              shipping  : ${formatAddress(profile.shippingAddress)}`)

  if (!profile.email) {
    const err = new Error(`Order ${order.id} has no email; cannot create customer in QBO/NMI`)
    console.error(`[customers] ABORT — ${err.message}`)
    throw err
  }

  // NMI rejects add_customer when no billing address is present. Detect
  // up front with a precise message instead of letting NMI's generic
  // "Billing Information missing" surface 100ms later.
  const billingMissing = missingBillingFields(profile.billingAddress)
  if (billingMissing.length > 0) {
    const err = new Error(
      `Order ${order.id}: cannot build NMI customer — billing address missing fields: ${billingMissing.join(', ')}. ` +
        `Checked order.billing_address, order.shipping_address, customer.default_address.`,
    )
    console.error(`[customers] ABORT — ${err.message}`)
    throw err
  }

  // Atomic find-or-create on the local mapping. We re-fetch after the
  // upsert so we can read whatever the previous run wrote.
  console.log(`[customers] upserting customer_maps row for ${shop} / ${profile.email}`)
  let mapping = await CustomerMap.findOneAndUpdate(
    { shop, email: profile.email },
    {
      $setOnInsert: { shop, email: profile.email },
      $set: {
        shopifyCustomerId: profile.shopifyCustomerId || undefined,
        profile: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          companyName: profile.companyName,
          phone: profile.phone,
          billingAddress: profile.billingAddress,
          shippingAddress: profile.shippingAddress,
        },
      },
    },
    { upsert: true, new: true },
  )
  console.log(
    `[customers] customer_maps _id=${mapping._id} qbo=${mapping.qboCustomerId || '(none)'} nmi=${mapping.nmiCustomerVaultId || '(none)'}`,
  )
  log.info('mapping.upserted', {
    shop,
    email: profile.email,
    mappingId: mapping._id.toString(),
    hasQbo: Boolean(mapping.qboCustomerId),
    hasNmi: Boolean(mapping.nmiCustomerVaultId),
  })

  // QBO side
  if (!mapping.qboCustomerId) {
    let customer
    try {
      ;({ customer } = await findOrCreateQboCustomer(profile))
    } catch (err) {
      await notifyQboCustomerSyncFailed({
        shop,
        email: profile.email,
        businessName: profile.companyName,
        shopifyOrderId: order?.id,
        error: err,
      }).catch((e) => log.error('qbo_sync_alert.failed', { err: e?.message || e }))
      throw err
    }
    mapping.qboCustomerId = customer.Id
    log.info('qbo.linked', { email: profile.email, qboCustomerId: customer.Id })
  } else {
    console.log(`[customers] QBO link already set on customer_maps: Id=${mapping.qboCustomerId}`)
  }

  // Payment-method preference + NMI vault link — both sourced from the
  // customer's wholesale_application doc on every order intake. The
  // vault id is captured ONCE at registration submit (see
  // app/api/registration-form.js) and is the single source of truth;
  // this service mirrors it onto CustomerMap as a runtime cache so the
  // payment service can read the vault id without a second collection
  // hit per charge.
  //
  // Historical invoices preserve their original preference via the
  // immutable `Invoice.customerPaymentPreference` snapshot written at
  // invoice creation, so flipping `paymentMethod` here does NOT rewrite
  // history. The cheque → card admin fallback mutates
  // `Invoice.paymentMethod`, never this customer-level value.
  const app = await WholesaleApplication.findOne({ shop, email: profile.email })
    .select('payment.method payment.card payment.ach nmiCustomerVaultId cardFeeOverridePercent')
    .lean()

  {
    const resolved = normalizePaymentMethod(app?.payment?.method)
    const previous = mapping.paymentMethod
    if (previous !== resolved) {
      console.log(
        `[customers] payment-method preference ${previous ? `${previous} → ${resolved}` : `→ "${resolved}"`}` +
          (app?.payment?.method
            ? ` (from wholesale_applications.payment.method="${app.payment.method}")`
            : ` (default; no application on file)`),
      )
      log.info('payment_method.resolved', {
        email: profile.email,
        previous: previous || null,
        paymentMethod: resolved,
        sourcedFromApp: Boolean(app?.payment?.method),
      })
      mapping.paymentMethod = resolved
    } else {
      console.log(`[customers] payment-method preference unchanged ("${resolved}")`)
    }
  }

  // Mirror the per-practitioner CARD-fee override onto the customer map so the
  // fee compute sites (invoice creation, chargeInvoice) can read it without a
  // separate lookup. Source of truth is wholesale_applications; null = default
  // card rate. Normalized to a finite >= 0 number or null.
  {
    const raw = app?.cardFeeOverridePercent
    const resolvedOverride =
      raw === null || raw === undefined || !Number.isFinite(Number(raw)) || Number(raw) < 0
        ? null
        : Number(raw)
    if (mapping.cardFeeOverridePercent !== resolvedOverride) {
      mapping.cardFeeOverridePercent = resolvedOverride
    }
  }

  // NMI side — read-through from wholesale_applications. We do NOT
  // create vaults here. If the application has no vault on file (the
  // customer registered without payment, or vault creation failed
  // during registration), `mapping.nmiCustomerVaultId` is left empty
  // and any downstream charge will be skipped with a clear "no vault
  // on file" reason by payment.service.chargeInvoice.
  const sourceVaultId = app?.nmiCustomerVaultId || null
  if (!sourceVaultId) {
    if (mapping.nmiCustomerVaultId) {
      console.log(
        `[customers] WARN — customer_maps.nmiCustomerVaultId=${mapping.nmiCustomerVaultId} but ` +
          `wholesale_applications has no vault id; clearing cache so the source of truth wins`,
      )
      log.warn('nmi.vault.cleared_stale_cache', { email: profile.email })
      mapping.nmiCustomerVaultId = undefined
    } else {
      console.log(
        `[customers] no NMI vault on wholesale_applications for ${profile.email} — ` +
          `card charges will be skipped until one is captured at registration`,
      )
      log.info('nmi.vault.missing_on_application', { email: profile.email })
    }
  } else {
    // Validate the vault id is still resolvable in NMI before we
    // promote it onto CustomerMap. This is the pre-flight required by
    // every payment-related operation — failures here mean the
    // downstream charge code never has to second-guess the vault id.
    console.log(`[customers] NMI vault from wholesale_applications: ${sourceVaultId} — validating`)
    const { valid, reason } = await validateCustomerVault(sourceVaultId)
    if (!valid) {
      console.log(
        `[customers] WARN — NMI vault ${sourceVaultId} did not validate: ${reason}. ` +
          `Charges for ${profile.email} will be skipped until the vault is re-captured.`,
      )
      log.warn('nmi.vault.invalid', { email: profile.email, customerVaultId: sourceVaultId, reason })
      // Drop the stale id from the runtime cache so the payment
      // service's "no vault on file" guard fires correctly.
      mapping.nmiCustomerVaultId = undefined
    } else {
      if (mapping.nmiCustomerVaultId !== sourceVaultId) {
        console.log(
          `[customers] NMI vault link updated on customer_maps: ${mapping.nmiCustomerVaultId || '(none)'} → ${sourceVaultId}`,
        )
        log.info('nmi.linked', { email: profile.email, customerVaultId: sourceVaultId })
        mapping.nmiCustomerVaultId = sourceVaultId
      } else {
        console.log(`[customers] NMI vault link unchanged on customer_maps: ${sourceVaultId}`)
      }
    }
  }

  // Mirror NMI billing_ids from the application. Card billing is always
  // present (card on file required for all wholesale accounts); ACH billing
  // only for customers whose preferred method was ACH at registration.
  // chargeInvoice uses these to target a specific billing when the invoice
  // payment method requires it (e.g., admin "Charge card on file" fallback
  // on an ACH-default customer).
  const sourceCardBillingId = app?.payment?.card?.nmi_billing_id || null
  const sourceAchBillingId = app?.payment?.ach?.nmi_billing_id || null
  if (mapping.nmiCardBillingId !== sourceCardBillingId) {
    mapping.nmiCardBillingId = sourceCardBillingId
    console.log(`[customers] nmi card billing_id updated: ${sourceCardBillingId || '(none)'}`)
  }
  if (mapping.nmiAchBillingId !== sourceAchBillingId) {
    mapping.nmiAchBillingId = sourceAchBillingId
    console.log(`[customers] nmi ach billing_id updated: ${sourceAchBillingId || '(none)'}`)
  }

  mapping.lastSyncedAt = new Date()
  await mapping.save()
  console.log(`[customers] customer_maps saved _id=${mapping._id}`)
  return mapping
}

// Ensure the synthetic retail drop-ship customer
// (DROPSHIP_RETAIL_CUSTOMER_EMAIL) is mapped to a QBO customer, WITHOUT the
// wholesale NMI-vault / billing-address requirements.
//
// Why a separate path from ensureCustomerForOrder:
//   - Drop-ship invoices are collected by the dedicated
//     process-dropship-payments CRON against a SINGLE configured NMI vault
//     (DROPSHIP_NMI_VAULT_ID), not a per-customer registration vault — so we
//     never source / validate a vault here and never write
//     CustomerMap.nmiCustomerVaultId (the CRON injects the configured vault
//     at charge time).
//   - The synthetic customer has no wholesale_applications doc and the
//     drop-ship Shopify order may arrive without a billing address, so the
//     wholesale "billing address required for NMI" hard-fail must NOT apply.
//
// We still create / reuse the QBO customer (find-or-create by email, so every
// drop-ship invoice consolidates under one QBO customer) and persist a
// CustomerMap row carrying `qboCustomerId` + `email` — the two fields
// createInvoiceForOrder + propagateSuccessfulPayment read. `paymentMethod` is
// intentionally left unset on the map (its enum has no 'dropship'); the
// invoice locks the method itself via createInvoiceForOrder({ isDropship }).
export async function ensureDropshipCustomerMap({ shop, order }) {
  const profile = buildProfileFromShopifyOrder(order)
  if (!profile.email) {
    throw new Error(`Drop-ship order ${order.id} has no email; cannot create QBO customer`)
  }
  console.log(`[customers] ensureDropshipCustomerMap(shop=${shop}, email=${profile.email})`)

  let mapping = await CustomerMap.findOneAndUpdate(
    { shop, email: profile.email },
    {
      $setOnInsert: { shop, email: profile.email },
      $set: {
        shopifyCustomerId: profile.shopifyCustomerId || undefined,
        profile: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          companyName: profile.companyName,
          phone: profile.phone,
          billingAddress: profile.billingAddress,
          shippingAddress: profile.shippingAddress,
        },
      },
    },
    { upsert: true, new: true },
  )

  if (!mapping.qboCustomerId) {
    let customer
    try {
      ;({ customer } = await findOrCreateQboCustomer(profile))
    } catch (err) {
      await notifyQboCustomerSyncFailed({
        shop,
        email: profile.email,
        businessName: profile.companyName,
        shopifyOrderId: order?.id,
        error: err,
      }).catch((e) => log.error('qbo_sync_alert.failed', { err: e?.message || e }))
      throw err
    }
    mapping.qboCustomerId = customer.Id
    log.info('dropship.qbo.linked', { email: profile.email, qboCustomerId: customer.Id })
    console.log(`[customers] drop-ship QBO customer linked Id=${customer.Id}`)
  } else {
    console.log(`[customers] drop-ship QBO link already set: Id=${mapping.qboCustomerId}`)
  }

  mapping.lastSyncedAt = new Date()
  await mapping.save()
  return mapping
}

// Resolve the NMI customer vault id for a customer at a specific shop.
//
// `customer_maps.nmiCustomerVaultId` is just a cache that's populated
// by ensureCustomerForOrder at order intake. The source of truth is
// `wholesale_applications.nmiCustomerVaultId`. If a customer captured
// a card AFTER their first order was already processed (or first
// order pre-dates the cumulative-sync customer.service refactor), the
// cache shows `null` while the source has the real vault id. The
// Order Details page and the charge-card / retry-payment endpoints
// would then disable / reject the action even though the card is on
// file. This helper closes that gap:
//
//   1. Use `customer_maps.nmiCustomerVaultId` if set (fast path)
//   2. Otherwise read `wholesale_applications.nmiCustomerVaultId`
//   3. If found there but missing from the cache, lazily sync (and
//      log) so subsequent reads on either side stay consistent.
//
// Returns the resolved vault id, or null if neither source has one.
// `customerMap` is optional — if not passed, we look it up by email.
export async function resolveCustomerVaultId({ shop, email, customerMap }) {
  if (!shop || !email) return null
  const normalizedEmail = String(email).toLowerCase()

  let cacheVaultId = customerMap?.nmiCustomerVaultId || null
  if (cacheVaultId) return cacheVaultId

  // Cache miss — consult wholesale_applications (source of truth).
  const app = await WholesaleApplication.findOne({
    shop,
    email: normalizedEmail,
  })
    .select('nmiCustomerVaultId')
    .lean()
  const sourceVaultId = app?.nmiCustomerVaultId || null
  if (!sourceVaultId) return null

  // Source has it, cache doesn't — lazily sync so the next reader on
  // either side gets the same answer. Unconditional upsert keeps this
  // safe across races (if a parallel ensureCustomerForOrder wrote it
  // already, this is a no-op).
  console.log(
    `[customers] lazy vault sync — copying nmiCustomerVaultId=${sourceVaultId} ` +
      `from wholesale_applications → customer_maps for ${normalizedEmail}`,
  )
  log.info('vault.lazy_sync', { shop, email: normalizedEmail, customerVaultId: sourceVaultId })
  await CustomerMap.updateOne(
    { shop, email: normalizedEmail },
    {
      $setOnInsert: { shop, email: normalizedEmail },
      $set: { nmiCustomerVaultId: sourceVaultId, lastSyncedAt: new Date() },
    },
    { upsert: true },
  )
  return sourceVaultId
}

// Resolve the NMI ACH billing id for a customer at a specific shop.
// Sibling of `resolveCustomerVaultId` but consults
// `wholesale_applications.payment.ach.nmi_billing_id` instead of the
// top-level vault id. Used by:
//   - payment.service.chargeInvoice when invoice.paymentMethod === 'ach'
//   - the Order Details loader to gate the "Retry ACH" / "Charge card on
//     file" buttons correctly (an ACH-failed invoice with a card vault
//     gets the card-fallback button; without a card vault it doesn't).
//
// Cache-then-source fallback identical to resolveCustomerVaultId:
//   1. customer_maps.nmiAchBillingId (fast path)
//   2. wholesale_applications.payment.ach.nmi_billing_id (source of truth)
//   3. lazy sync on miss
export async function resolveCustomerAchBillingId({ shop, email, customerMap }) {
  if (!shop || !email) return null
  const normalizedEmail = String(email).toLowerCase()

  const cached = customerMap?.nmiAchBillingId || null
  if (cached) return cached

  const app = await WholesaleApplication.findOne({
    shop,
    email: normalizedEmail,
  })
    .select('payment.ach')
    .lean()
  const sourceBillingId = app?.payment?.ach?.nmi_billing_id || null
  if (!sourceBillingId) return null

  console.log(
    `[customers] lazy ACH billing sync — copying nmi_billing_id=${sourceBillingId} ` +
      `from wholesale_applications.payment.ach → customer_maps for ${normalizedEmail}`,
  )
  log.info('vault.ach_billing.lazy_sync', { shop, email: normalizedEmail, nmiBillingId: sourceBillingId })
  await CustomerMap.updateOne(
    { shop, email: normalizedEmail },
    {
      $setOnInsert: { shop, email: normalizedEmail },
      $set: { nmiAchBillingId: sourceBillingId, lastSyncedAt: new Date() },
    },
    { upsert: true },
  )
  return sourceBillingId
}

// Resolve the NMI CARD billing id for a customer at a specific shop.
// Sibling of `resolveCustomerAchBillingId`, consulting
// `wholesale_applications.payment.card.nmi_billing_id`. The card billing id
// is normally mirrored onto `customer_maps.nmiCardBillingId` at order intake
// (ensureCustomerForOrder), but a practitioner who updates or ADDS a card via
// the portal (profile.service) after their last order was processed leaves the
// cache stale/null. chargeInvoice targets `customerMap.nmiCardBillingId` for
// card charges, so a stale cache makes a retry hit the vault's default
// (priority-1) billing instead of the card the practitioner just set — the
// exact gap this closes on the manual-retry path.
//
// Cache-then-source fallback identical to the vault/ACH resolvers:
//   1. customer_maps.nmiCardBillingId (fast path)
//   2. wholesale_applications.payment.card.nmi_billing_id (source of truth)
//   3. lazy sync on miss
export async function resolveCustomerCardBillingId({ shop, email, customerMap }) {
  if (!shop || !email) return null
  const normalizedEmail = String(email).toLowerCase()

  const cached = customerMap?.nmiCardBillingId || null
  if (cached) return cached

  const app = await WholesaleApplication.findOne({
    shop,
    email: normalizedEmail,
  })
    .select('payment.card')
    .lean()
  const sourceBillingId = app?.payment?.card?.nmi_billing_id || null
  if (!sourceBillingId) return null

  console.log(
    `[customers] lazy card billing sync — copying nmi_billing_id=${sourceBillingId} ` +
      `from wholesale_applications.payment.card → customer_maps for ${normalizedEmail}`,
  )
  log.info('vault.card_billing.lazy_sync', { shop, email: normalizedEmail, nmiBillingId: sourceBillingId })
  await CustomerMap.updateOne(
    { shop, email: normalizedEmail },
    {
      $setOnInsert: { shop, email: normalizedEmail },
      $set: { nmiCardBillingId: sourceBillingId, lastSyncedAt: new Date() },
    },
    { upsert: true },
  )
  return sourceBillingId
}

