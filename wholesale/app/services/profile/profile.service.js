// Profile update service.
//
// `maskedProfileForRead` returns the practitioner's data for autofill.
// `updateProfileApplication` applies a partial update, syncing changes
// to MongoDB AND to the Shopify customer record where appropriate.
//
// Sections handled (mirrors the registration form):
//   • personal     → firstName, lastName, phone   (also pushed to Shopify customer)
//   • business     → businessName                  (also pushed to Shopify customer note)
//   • credentials  → credentials.*  + license file uploads to Shopify Files
//   • address      → billingAddress                (also pushed to Shopify default address)
//                    + shippingAddress + shippingSameAsBilling + shippingPropertyType
//   • reseller     → resellsProducts (boolean)
//   • tax          → taxIdType, taxId, salesPermit, exemptState, itemsToResell, businessActivity
//   • payment      → payment.method (triggers invoice realign on change)
//   • card         → cardholderName, cardBrand, cardLast4 (display only —
//                    Collect.js token update happens via the card-popup flow)
//   • ach          → achAccountName, achRoutingNumber, achAccountLast4, achAccountType
//   • commission   → enabled + bankAccountName, bankRoutingNumber,
//                    bankAccountLast4, bankAccountType, sourcedFromPaymentAch
//   • w9           → full sub-doc + signature (typed text OR uploaded image)
//   • communications → subscribeNews (boolean)
//
// Fields intentionally NOT updatable here:
//   • email  → identity; changes in Shopify's native customer account
//   • password → password reset is Shopify's domain
//   • signature (Step 3 terms acceptance) → one-time legal artifact
//   • termsAccepted → one-time legal artifact
//   • referrals → one-time "where did you hear about us"

import crypto from 'node:crypto'
import { uploadFileToShopify } from '../shopify/shopify.service'
import {
  customerUpdatePersonalInfo,
  customerUpdateDefaultAddress,
  customerUpdateNote,
} from '../../utils/shopifyCustomer'
import { buildShopifyNote } from '../shopify/shopify.utils'
import { normalizePaymentMethod } from '../customer/customer.utils'
import { applyPaymentPreferenceToOpenInvoices } from '../invoice/paymentPreference.service'
import {
  addBillingToCustomerVault,
  updateBillingInCustomerVault,
} from '../nmi/nmi.service'
import { encryptField } from '../../utils/crypto.utils'
import { createLogger } from '../../utils/logger.utils'

const log = createLogger('profile.service')

// Strip empty strings from enum-typed W-9 fields.
function stripEmptyEnums(obj, enumKeys) {
  if (!obj || typeof obj !== 'object') return obj
  const clean = { ...obj }
  for (const k of enumKeys) {
    if (clean[k] === '') delete clean[k]
  }
  return clean
}

const W9_ENUM_KEYS = ['taxClassification', 'llcClassification']

// ── Public: GET shape (safe for transport to the client) ───────────────
export function maskedProfileForRead(application) {
  const doc = application.toObject?.() || application
  return {
    firstName: doc.firstName || '',
    lastName: doc.lastName || '',
    email: doc.email || '',
    phone: doc.phone || '',
    businessName: doc.businessName || '',
    billingAddress: doc.billingAddress || null,
    shippingAddress: doc.shippingAddress || null,
    shippingSameAsBilling: doc.shippingSameAsBilling !== false,
    shippingPropertyType: doc.shippingPropertyType || 'Residential',
    resellsProducts: doc.resellsProducts !== false,
    tax: doc.tax || null,
    credentials: doc.credentials || {},
    referrals: doc.referrals || {},
    payment: {
      method: doc.payment?.method || null,
      card: doc.payment?.card
        ? {
            cardholderName: doc.payment.card.cardholderName || '',
            cardBrand: doc.payment.card.cardBrand || '',
            cardLast4: doc.payment.card.cardLast4 || '',
          }
        : null,
      ach: doc.payment?.ach
        ? {
            achAccountName: doc.payment.ach.achAccountName || '',
            achRoutingNumber: doc.payment.ach.achRoutingNumber || '',
            achAccountLast4: doc.payment.ach.achAccountLast4 || '',
            achAccountType: doc.payment.ach.achAccountType || '',
          }
        : null,
    },
    commission: doc.commission
      ? {
          enabled: !!doc.commission.enabled,
          // Payout method selector (ach | check). Default to 'ach' for
          // legacy rows pre-dating the field — every legacy commission
          // record has bank fields populated, no check fields. Without
          // projecting this, the profile-update UI couldn't pre-select
          // the user's actual choice when they picked Check.
          payoutMethod:
            doc.commission.payoutMethod === 'check' ? 'check' : 'ach',
          // ── ACH branch (used when payoutMethod === 'ach') ──────────
          bankAccountName: doc.commission.bankAccountName || '',
          bankRoutingNumber: doc.commission.bankRoutingNumber || '',
          bankAccountLast4: doc.commission.bankAccountLast4 || '',
          bankAccountType: doc.commission.bankAccountType || '',
          sourcedFromPaymentAch: !!doc.commission.sourcedFromPaymentAch,
          // ── Check branch (used when payoutMethod === 'check') ──────
          // Without this block, Check-payout customers opening their
          // profile would see ACH fields with no data, AND silently lose
          // their payableTo + mailing address on save (the client would
          // re-send empty defaults). Project the full check subdoc so the
          // UI can autofill all of it.
          check: doc.commission.check
            ? {
                payableTo: doc.commission.check.payableTo || '',
                useBillingAddress:
                  doc.commission.check.useBillingAddress !== false,
                mailingAddress: doc.commission.check.mailingAddress
                  ? {
                      line1: doc.commission.check.mailingAddress.line1 || '',
                      line2: doc.commission.check.mailingAddress.line2 || '',
                      city: doc.commission.check.mailingAddress.city || '',
                      state: doc.commission.check.mailingAddress.state || '',
                      zip: doc.commission.check.mailingAddress.zip || '',
                      country: doc.commission.check.mailingAddress.country || '',
                    }
                  : null,
              }
            : null,
        }
      : null,
    w9: doc.w9
      ? {
          legalName: doc.w9.legalName || '',
          taxClassification: doc.w9.taxClassification || '',
          llcClassification: doc.w9.llcClassification || '',
          otherClassification: doc.w9.otherClassification || '',
          exemptPayeeCode: doc.w9.exemptPayeeCode || '',
          fatcaCode: doc.w9.fatcaCode || '',
          signature: doc.w9.signature
            ? {
                type: doc.w9.signature.type || null,
                value: doc.w9.signature.value || null,
                signedAt: doc.w9.signature.signedAt || null,
              }
            : null,
          submittedAt: doc.w9.submittedAt || null,
        }
      : null,
    subscribeNews: !!doc.subscribeNews,
  }
}

// ── Public: write-side orchestrator ────────────────────────────────────
export async function updateProfileApplication({
  application,
  payload,
  admin = null,
  files = {},
  performedBy = 'self-service',
}) {
  if (!application) throw new Error('updateProfileApplication: application required')

  // `errors[]` blocks the save (sets ok:false). `warnings[]` is best-effort
  // failures that left the data in a recoverable state — the local Mongo
  // save succeeded; only a downstream Shopify sync hiccuped. Those should
  // surface to the user as info, not "Couldn't save".
  const errors = []
  const warnings = []
  const fileUploads = {}
  const $set = {}
  // $unset hoisted to the top so multiple sections (commission branch-wipe
  // + W-9 classification clear) can contribute paths. Mongo accepts a
  // single $unset object combining all paths in one updateOne.
  const $unset = {}
  let paymentMethodRealign = null
  let addressChangedForShopify = null
  let personalChangedForShopify = null
  let noteNeedsRebuild = false

  // ── Personal info ────────────────────────────────────────────────────
  if (payload.personal && typeof payload.personal === 'object') {
    const p = payload.personal
    const next = {}
    if (typeof p.firstName === 'string' && p.firstName.trim()) {
      $set.firstName = p.firstName.trim()
      next.firstName = p.firstName.trim()
    }
    if (typeof p.lastName === 'string' && p.lastName.trim()) {
      $set.lastName = p.lastName.trim()
      next.lastName = p.lastName.trim()
    }
    if (typeof p.phone === 'string' && p.phone.trim()) {
      $set.phone = p.phone.trim()
      next.phone = p.phone.trim()
    }
    if (Object.keys(next).length > 0) {
      personalChangedForShopify = next
      noteNeedsRebuild = true
    }
  }

  // ── Business identity ────────────────────────────────────────────────
  if (payload.business && typeof payload.business === 'object') {
    const { businessName } = payload.business
    if (typeof businessName === 'string' && businessName.trim()) {
      $set.businessName = businessName.trim()
      noteNeedsRebuild = true
    }
  }

  // ── Address (billing + shipping) ────────────────────────────────────
  if (payload.address && typeof payload.address === 'object') {
    const a = payload.address
    const billing = a.billingAddress || {}
    const keys = ['line1', 'line2', 'city', 'state', 'zip', 'country']
    let billingTouched = false
    for (const k of keys) {
      if (billing[k] != null) {
        $set[`billingAddress.${k}`] = billing[k]
        billingTouched = true
      }
    }
    if (typeof a.shippingSameAsBilling === 'boolean') {
      $set.shippingSameAsBilling = a.shippingSameAsBilling
    }
    if (a.shippingPropertyType) $set.shippingPropertyType = a.shippingPropertyType
    if (a.shippingSameAsBilling === true) {
      $set.shippingAddress = null
    } else if (a.shippingAddress && typeof a.shippingAddress === 'object') {
      for (const k of keys) {
        if (a.shippingAddress[k] != null) {
          $set[`shippingAddress.${k}`] = a.shippingAddress[k]
        }
      }
    }
    if (billingTouched) {
      addressChangedForShopify = { ...billing }
      noteNeedsRebuild = true
    }
  }

  // ── resellsProducts (boolean) ────────────────────────────────────────
  if (typeof payload.resellsProducts === 'boolean') {
    $set.resellsProducts = payload.resellsProducts
    noteNeedsRebuild = true
  }

  // ── Tax info ─────────────────────────────────────────────────────────
  if (payload.tax && typeof payload.tax === 'object') {
    const taxKeys = [
      'taxIdType',
      'taxId',
      'salesPermit',
      'exemptState',
      'itemsToResell',
      'businessActivity',
    ]
    for (const k of taxKeys) {
      const v = payload.tax[k]
      if (v != null) $set[`tax.${k}`] = v
    }
    noteNeedsRebuild = true
  }

  // ── Credentials + license file uploads ──────────────────────────────
  if (payload.credentials && typeof payload.credentials === 'object') {
    const existing =
      (application.credentials && typeof application.credentials === 'object'
        ? application.credentials
        : {}) || {}
    const merged = { ...existing }
    for (const [credKey, credVal] of Object.entries(payload.credentials)) {
      if (!credVal || typeof credVal !== 'object') continue
      merged[credKey] = { ...(merged[credKey] || {}), ...credVal }
    }

    if (admin && files?.credentialFiles && typeof files.credentialFiles === 'object') {
      for (const [credKey, file] of Object.entries(files.credentialFiles)) {
        if (!file) continue
        try {
          const uploaded = await uploadFileToShopify(admin, file)
          const url = uploaded?.url || uploaded?.publicUrl || null
          if (url) {
            merged[credKey] = {
              ...(merged[credKey] || {}),
              license: {
                ...((merged[credKey] && merged[credKey].license) || {}),
                fileUrl: url,
                fileName: file.name || null,
                uploadedAt: new Date().toISOString(),
              },
            }
            fileUploads[credKey] = url
          }
        } catch (e) {
          log.error('credential_upload_failed', { credKey, err: e?.message || String(e) })
          errors.push({
            section: 'credentials',
            field: credKey,
            message: 'License upload failed',
          })
        }
      }
    }
    $set.credentials = merged
    noteNeedsRebuild = true
  }

  // ── Payment method (with invoice realign) ───────────────────────────
  const requestedMethod = payload.payment?.method
  let methodActuallyChanged = false
  if (typeof requestedMethod === 'string' && requestedMethod.trim()) {
    const oldNormalized = normalizePaymentMethod(application.payment?.method)
    const newNormalized = normalizePaymentMethod(requestedMethod)
    $set['payment.method'] = requestedMethod
    if (oldNormalized !== newNormalized) methodActuallyChanged = true
    noteNeedsRebuild = true
  }

  // ── Card on file — server-side NMI tokenization ─────────────────────
  //
  // PCI WARNING: the practitioner submits RAW card data via plain text
  // inputs in the customer-account extension. The data lands here on
  // the server. We MUST:
  //   1. Never persist the raw card number / CVV (only last4 + brand)
  //   2. Never log the raw values
  //   3. Forward them to NMI in a single transact.php call and discard
  //      them after the response is received
  //
  // Update flow:
  //   • If the vault already has a card billing_id → update_billing
  //   • If the vault has no card billing_id        → add_billing (new id)
  //   • If no vault on this customer at all        → reject (admin must
  //                                                    initialise vault)
  if (payload.card && typeof payload.card === 'object') {
    const c = payload.card
    const cardNumberRaw = String(c.cardNumber || '').replace(/\D/g, '')
    const cardExpiryRaw = String(c.cardExpiry || '').replace(/\D/g, '') // MMYY
    const cardCvvRaw = String(c.cardCvv || '').replace(/\D/g, '')

    if (cardNumberRaw) {
      const vaultId = application.nmiCustomerVaultId
      if (!vaultId) {
        errors.push({
          section: 'card',
          message:
            'No payment vault on file — please contact support to initialise your payment profile.',
        })
      } else if (cardNumberRaw.length < 12 || cardNumberRaw.length > 19) {
        errors.push({ section: 'card', message: 'Card number length is invalid.' })
      } else if (cardExpiryRaw.length !== 4) {
        errors.push({ section: 'card', message: 'Expiry must be in MMYY format.' })
      } else {
        const profile = {
          firstName: application.firstName || '',
          lastName: application.lastName || '',
          companyName: application.businessName || '',
          phone: application.phone || '',
          email: application.email || '',
          billingAddress: application.billingAddress || null,
        }
        const paymentDetails = {
          cardNumber: cardNumberRaw,
          cardExpiry: cardExpiryRaw,
          cardCvv: cardCvvRaw || undefined,
        }
        const existingBillingId = application.payment?.card?.nmi_billing_id

        try {
          if (existingBillingId) {
            await updateBillingInCustomerVault({
              customerVaultId: vaultId,
              billingId: existingBillingId,
              profile,
              paymentDetails,
            })
            log.info('nmi.card_updated_in_place', { vaultId, billingId: existingBillingId })
          } else {
            const newBillingId = `card_${crypto.randomBytes(6).toString('hex')}`
            await addBillingToCustomerVault({
              customerVaultId: vaultId,
              billingId: newBillingId,
              profile,
              paymentDetails,
            })
            $set['payment.card.nmi_billing_id'] = newBillingId
            log.info('nmi.card_billing_added', { vaultId, billingId: newBillingId })
          }

          // NMI accepted — persist DISPLAY fields only. NEVER log or
          // store the raw PAN / CVV beyond this point.
          if (c.cardholderName) $set['payment.card.cardholderName'] = c.cardholderName
          $set['payment.card.cardLast4'] = cardNumberRaw.slice(-4)
          // Brand can be derived from the card number's first digits; for
          // simplicity, accept what the client passed OR leave as-is.
          if (c.cardBrand) $set['payment.card.cardBrand'] = c.cardBrand
        } catch (err) {
          log.error('nmi.card_update_failed', {
            err: err?.message || String(err),
            // CRITICAL: do not include raw card data in error logs.
          })
          errors.push({
            section: 'card',
            message:
              err?.message?.startsWith('NMI ')
                ? 'Your card was rejected by the payment processor. Please double-check the details.'
                : 'Could not save your card. Please try again.',
          })
        }
      }
    } else {
      // No new card number provided — only update display name if changed.
      if (c.cardholderName) $set['payment.card.cardholderName'] = c.cardholderName
    }
  }

  // ── ACH (display fields + last4 + NMI vault billing) ────────────────
  // Write the whole `payment.ach` sub-doc at once. Dotted-path updates
  // like `payment.ach.achAccountType` fail when the current value of
  // `payment.ach` is null (Mongo can't create a field inside null).
  // Merging with the existing sub-doc also preserves fields the
  // frontend doesn't send (e.g., nmi_billing_id set at registration).
  //
  // Gate: the frontend always sends `achAccountType: 'Checking'` as a
  // default even when the user never touched the ACH section. To avoid
  // creating an empty ACH stub for non-ACH practitioners, only write
  // when there's a real ACH identity OR the user is editing existing
  // ACH (i.e., a prior sub-doc already exists).
  //
  // When a fresh `achAccountNumber` is provided, push the new ACH
  // billing to NMI (same flow as the card path — update existing
  // billing_id in place, or add a new one). Routing + account never
  // get persisted in Mongo; only last4 + account type + billing id.
  if (payload.ach && typeof payload.ach === 'object') {
    const a = payload.ach
    const existing = application.payment?.ach || {}
    const hasExisting = Object.keys(existing).length > 0
    const hasIdentity = a.achAccountName || a.achRoutingNumber || a.achAccountLast4
    const rawAccountNumber = String(a.achAccountNumber || '').replace(/\D/g, '')
    const rawRouting = String(a.achRoutingNumber || '').replace(/\D/g, '')

    if (hasIdentity || hasExisting || rawAccountNumber) {
      const next = { ...existing }
      if (a.achAccountName) next.achAccountName = a.achAccountName
      if (a.achRoutingNumber) next.achRoutingNumber = a.achRoutingNumber
      if (a.achAccountLast4) next.achAccountLast4 = a.achAccountLast4
      if (a.achAccountType) next.achAccountType = a.achAccountType

      if (rawAccountNumber) {
        const vaultId = application.nmiCustomerVaultId
        if (!vaultId) {
          errors.push({
            section: 'ach',
            message:
              'No payment vault on file — please contact support to initialise your payment profile.',
          })
        } else if (!rawRouting || rawRouting.length !== 9) {
          errors.push({ section: 'ach', message: 'Routing number must be 9 digits.' })
        } else if (rawAccountNumber.length < 4 || rawAccountNumber.length > 17) {
          errors.push({ section: 'ach', message: 'ACH account number length is invalid.' })
        } else {
          const profile = {
            firstName: application.firstName || '',
            lastName: application.lastName || '',
            companyName: application.businessName || '',
            phone: application.phone || '',
            email: application.email || '',
            billingAddress: application.billingAddress || null,
          }
          const paymentDetails = {
            achRouting: rawRouting,
            achAccount: rawAccountNumber,
            achAccountType: (a.achAccountType || 'Checking').toLowerCase(),
            checkName: a.achAccountName || '',
          }
          const existingAchBillingId = existing.nmi_billing_id
          try {
            if (existingAchBillingId) {
              await updateBillingInCustomerVault({
                customerVaultId: vaultId,
                billingId: existingAchBillingId,
                profile,
                paymentDetails,
              })
              log.info('nmi.ach_updated_in_place', {
                vaultId,
                billingId: existingAchBillingId,
              })
            } else {
              const newBillingId = `ach_${crypto.randomBytes(6).toString('hex')}`
              await addBillingToCustomerVault({
                customerVaultId: vaultId,
                billingId: newBillingId,
                profile,
                paymentDetails,
              })
              next.nmi_billing_id = newBillingId
              log.info('nmi.ach_billing_added', { vaultId, billingId: newBillingId })
            }
            // Persist last4 from the server-side raw value (don't trust the
            // client to compute it consistently).
            next.achAccountLast4 = rawAccountNumber.slice(-4)
          } catch (err) {
            log.error('nmi.ach_update_failed', {
              err: err?.message || String(err),
              // CRITICAL: do not include raw ACH digits in error logs.
            })
            errors.push({
              section: 'ach',
              message:
                err?.message?.startsWith('NMI ')
                  ? 'Your bank account was rejected by the payment processor. Please double-check the details.'
                  : 'Could not save your bank account. Please try again.',
            })
          }
        }
      }

      $set['payment.ach'] = next
    }
  }

  // ── Commission bank ─────────────────────────────────────────────────
  // Commissions are a one-way payout (we don't charge this account), so
  // they bypass NMI. The full account number is encrypted at rest with
  // AES-256-GCM via `encryptField` — only an admin with access to
  // SHOPIFY_API_SECRET (and the new bankAccountEncrypted field) can
  // recover it for payout instructions.
  //
  // Two payout branches (mirrors app/api/registration-form.js lines
  // 216–282 — keep the two in lockstep):
  //   • payoutMethod === 'ach'   → save bank fields; encrypt new account
  //                                 number when supplied (empty = keep
  //                                 existing encrypted). $unset wipes
  //                                 commission.check.
  //   • payoutMethod === 'check' → save check.payableTo + mailing address
  //                                 (resolved against billingAddress when
  //                                 useBillingAddress=true). $unset wipes
  //                                 the ACH fields.
  // Branch wipe is essential: without it, switching payout method would
  // leave stale fields from the previous branch on the doc.
  if (payload.commission && typeof payload.commission === 'object') {
    const c = payload.commission
    const method = c.payoutMethod === 'check' ? 'check' : 'ach'

    $set['commission.payoutMethod'] = method
    if (typeof c.enabled === 'boolean') $set['commission.enabled'] = c.enabled
    $set['commission.updatedAt'] = new Date()

    if (method === 'ach') {
      // ── ACH branch ──────────────────────────────────────────────────
      // When sourcedFromPaymentAch=true, derive bank* from the doc's
      // payment.ach.* (defense in depth — client mirrors them on tick,
      // server is source of truth).
      const useSourceFromPayment = !!c.sourcedFromPaymentAch
      const paymentAch =
        application.payment?.ach?.toObject?.() ?? application.payment?.ach ?? {}

      if (useSourceFromPayment) {
        $set['commission.bankAccountName'] =
          paymentAch.achAccountName || c.bankAccountName || ''
        $set['commission.bankRoutingNumber'] =
          paymentAch.achRoutingNumber || c.bankRoutingNumber || ''
        $set['commission.bankAccountType'] =
          paymentAch.achAccountType || c.bankAccountType || ''
      } else {
        if (c.bankAccountName && String(c.bankAccountName).trim()) {
          $set['commission.bankAccountName'] = c.bankAccountName
        }
        if (c.bankRoutingNumber && String(c.bankRoutingNumber).trim()) {
          $set['commission.bankRoutingNumber'] = c.bankRoutingNumber
        }
        if (c.bankAccountType && String(c.bankAccountType).trim()) {
          $set['commission.bankAccountType'] = c.bankAccountType
        }
      }
      $set['commission.sourcedFromPaymentAch'] = useSourceFromPayment

      const rawAccount = String(c.bankAccountNumber || '').replace(/\D/g, '')
      const hasExistingEncrypted = !!application.commission?.bankAccountEncrypted

      // Integrity guard — block ACH save with no encrypted account on
      // file AND no new account number. Catches Check→ACH switch where
      // prior $unset wiped the encrypted value.
      if (!rawAccount && !hasExistingEncrypted && !useSourceFromPayment) {
        errors.push({
          section: 'commission',
          message:
            'Bank account number is required when switching to ACH for the first time. Please enter your bank account number.',
        })
      } else if (rawAccount) {
        $set['commission.bankAccountLast4'] = rawAccount.slice(-4)
        try {
          $set['commission.bankAccountEncrypted'] = encryptField(rawAccount)
        } catch (e) {
          log.error('commission.encrypt_failed', { err: e?.message || String(e) })
          errors.push({
            section: 'commission',
            message: 'Could not securely save your commission bank account.',
          })
        }
      }
      // Empty bankAccountNumber + existing encrypted → keep existing.

      // Wipe the Check branch — only the selected method's data remains.
      $unset['commission.check'] = ''
    } else {
      // ── Check branch ────────────────────────────────────────────────
      if (!c.check || typeof c.check !== 'object') {
        errors.push({
          section: 'commission',
          message: 'Check payout details are required (payableTo + mailing address).',
        })
      } else {
        const chk = c.check
        const useBilling = chk.useBillingAddress !== false // default true

        // When useBillingAddress=true, copy from incoming address (if
        // any) merged over the doc's billingAddress baseline so partial
        // address edits don't blank out the mailing snapshot. Billing —
        // not shipping — is the financial-mail address.
        let mailing
        if (useBilling) {
          const billingBaseline =
            application.billingAddress?.toObject?.() ?? application.billingAddress ?? {}
          const billingIncoming =
            payload.address?.billingAddress && typeof payload.address.billingAddress === 'object'
              ? payload.address.billingAddress
              : {}
          const billingSource = { ...billingBaseline, ...billingIncoming }
          mailing = {
            line1: billingSource.line1 || '',
            line2: billingSource.line2 || '',
            city: billingSource.city || '',
            state: billingSource.state || '',
            zip: billingSource.zip || '',
            country: billingSource.country || '',
          }
        } else {
          const m = chk.mailingAddress || {}
          mailing = {
            line1: m.line1 || '',
            line2: m.line2 || '',
            city: m.city || '',
            state: m.state || '',
            zip: m.zip || '',
            country: m.country || '',
          }
        }

        const payableTo =
          chk.payableTo && String(chk.payableTo).trim()
            ? String(chk.payableTo).trim()
            : `${application.firstName || ''} ${application.lastName || ''}`.trim()

        $set['commission.check'] = {
          payableTo,
          useBillingAddress: useBilling,
          mailingAddress: mailing,
        }

        // Wipe the ACH branch — only the selected method's data remains.
        $unset['commission.bankAccountName'] = ''
        $unset['commission.bankRoutingNumber'] = ''
        $unset['commission.bankAccountEncrypted'] = ''
        $unset['commission.bankAccountLast4'] = ''
        $unset['commission.bankAccountType'] = ''
        $unset['commission.sourcedFromPaymentAch'] = ''
      }
    }
  }

  // ── W-9 form (signature REQUIRED on every save) ──────────────────────
  // ($unset is hoisted at the top of this function — the commission
  //  branch-wipe and W-9 classification clear both contribute paths.)
  if (payload.w9 && typeof payload.w9 === 'object') {
    const w9 = stripEmptyEnums(payload.w9, W9_ENUM_KEYS)

    let signature = null
    if (admin && files?.w9SignatureFile) {
      try {
        const uploaded = await uploadFileToShopify(admin, files.w9SignatureFile)
        const url = uploaded?.url || uploaded?.publicUrl || null
        if (url) signature = { type: 'drawn', value: url, signedAt: new Date() }
      } catch (e) {
        log.error('w9.signature_upload_failed', { err: e?.message || String(e) })
        errors.push({
          section: 'w9',
          message: 'Could not upload your signature. Please try again.',
        })
      }
    }
    if (!signature && w9.signature && typeof w9.signature === 'object') {
      const sigType = w9.signature.type === 'drawn' ? 'drawn' : 'typed'
      const sigValue = String(w9.signature.value || '').trim()
      if (sigValue) signature = { type: sigType, value: sigValue, signedAt: new Date() }
    }

    // Determine which classifications need to be cleared FIRST, so the
    // $set loop below can skip them. Mongo refuses to $set and $unset the
    // same path in a single update — "Updating the path 'X' would create
    // a conflict at 'X'" — and the frontend always sends an empty string
    // for the inapplicable classification (e.g., `otherClassification: ''`
    // when taxClassification !== 'other'), which would otherwise land in
    // both operators.
    const clearLlc =
      payload.w9.taxClassification && payload.w9.taxClassification !== 'llc'
    const clearOther =
      payload.w9.taxClassification && payload.w9.taxClassification !== 'other'

    const w9Keys = [
      'legalName',
      'taxClassification',
      'llcClassification',
      'otherClassification',
      'exemptPayeeCode',
      'fatcaCode',
    ]
    for (const k of w9Keys) {
      if (k === 'llcClassification' && clearLlc) continue
      if (k === 'otherClassification' && clearOther) continue
      if (w9[k] != null) $set[`w9.${k}`] = w9[k]
    }

    if (clearLlc) $unset['w9.llcClassification'] = ''
    if (clearOther) $unset['w9.otherClassification'] = ''

    if (signature) {
      $set['w9.signature'] = signature
      $set['w9.submittedAt'] = new Date()
    }
  }

  // ── subscribeNews ────────────────────────────────────────────────────
  if (typeof payload.subscribeNews === 'boolean') {
    $set.subscribeNews = payload.subscribeNews
  }

  // W-9 signature error aborts the whole save.
  const w9SigError = errors.find(
    (e) => e.section === 'w9' && /signature/i.test(e.message || ''),
  )
  if (w9SigError) {
    return {
      ok: false,
      updatedDoc: null,
      paymentMethodRealign: null,
      fileUploads,
      errors,
      warnings,
    }
  }

  if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) {
    return {
      ok: true,
      updatedDoc: maskedProfileForRead(application),
      paymentMethodRealign: null,
      fileUploads,
      errors: [{ section: 'global', message: 'No fields to update' }],
      warnings,
    }
  }

  // ── Persist to MongoDB ──────────────────────────────────────────────
  try {
    const update = {}
    if (Object.keys($set).length > 0) update.$set = $set
    if (Object.keys($unset).length > 0) update.$unset = $unset
    await application.constructor.updateOne({ _id: application._id }, update)
  } catch (e) {
    log.error('mongo.update_failed', { err: e?.message || String(e) })
    errors.push({
      section: 'global',
      message: 'Could not save your changes. Please try again.',
    })
    return {
      ok: false,
      updatedDoc: null,
      paymentMethodRealign: null,
      fileUploads,
      errors,
      warnings,
    }
  }

  // Reload for the response + downstream operations.
  const updatedApplication = await application.constructor.findById(application._id)

  // ── Sync to Shopify customer record (best-effort) ───────────────────
  const customerGid = updatedApplication.customerId
  if (admin && customerGid) {
    // 1. Personal info — firstName, lastName, phone
    if (personalChangedForShopify) {
      try {
        await customerUpdatePersonalInfo(admin, {
          customerId: customerGid,
          ...personalChangedForShopify,
        })
      } catch (err) {
        log.warn('shopify.personal_sync_failed', { err: err?.message || String(err) })
        warnings.push({
          section: 'personal',
          message:
            'Saved locally, but updating your Shopify customer record failed. An admin may need to reconcile.',
        })
      }
    }

    // 2. Address — push billing as default
    if (addressChangedForShopify) {
      try {
        await customerUpdateDefaultAddress(admin, {
          customerId: customerGid,
          address: addressChangedForShopify,
        })
      } catch (err) {
        log.warn('shopify.address_sync_failed', { err: err?.message || String(err) })
        warnings.push({
          section: 'address',
          message:
            'Saved locally, but updating your default address in Shopify failed.',
        })
      }
    }

    // 3. Customer note — rebuild from the fresh application doc
    if (noteNeedsRebuild) {
      try {
        const note = buildShopifyNote(updatedApplication.toObject())
        await customerUpdateNote(admin, { customerId: customerGid, note })
      } catch (err) {
        log.warn('shopify.note_sync_failed', { err: err?.message || String(err) })
      }
    }
  }

  // ── Realign open invoices on payment-method change ──────────────────
  if (methodActuallyChanged && updatedApplication.shop && updatedApplication.email) {
    try {
      paymentMethodRealign = await applyPaymentPreferenceToOpenInvoices({
        shop: updatedApplication.shop,
        email: updatedApplication.email,
        newMethod: normalizePaymentMethod(requestedMethod),
        performedBy,
        source: 'customer',
      })
    } catch (e) {
      log.error('invoice.realign_failed', { err: e?.message || String(e) })
      warnings.push({
        section: 'payment',
        message:
          'Your method was saved, but realigning open invoices failed. An admin will reconcile.',
      })
    }
  }

  return {
    ok: errors.length === 0,
    updatedDoc: maskedProfileForRead(updatedApplication),
    paymentMethodRealign,
    fileUploads,
    errors,
    warnings,
  }
}
