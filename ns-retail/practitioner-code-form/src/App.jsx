import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ApiService from './services/ApiService.js'

// Practitioner Code — cart-page React input.
//
// Grow-plan replacement for the checkout-ui-code extension. Same backend
// endpoints (called through Shopify's app proxy — see ApiService.js),
// same customer-tag mechanism to apply the discount at checkout. Only
// the entry point moves from checkout onto the cart page.
//
// Flow (Interpretation B):
//   1. Buyer types code → clicks Verify.
//   2. ApiService.verifyCode → /apps/retail-signup/api/cdo/checkout-validate-code
//   3. On valid:
//        a. POST /cart/update.js — save code + name + discount% to cart attrs.
//        b. If logged in, ApiService.applyAndTagCode — backend tags the
//           customer with `code:<code>`.
//        c. Shopify's tag-based automatic-discount rule then auto-applies
//           the discount at checkout (existing behaviour).

// UI copy — hardcoded here on purpose. The theme block exposes ZERO
// merchant-facing settings; edit these strings in source and rebuild.
const UI = {
  label: 'Do you have a practitioner code?',
  placeholder: 'e.g. parker_a1b2c3d4',
  buttonLabel: 'Verify',
  verifyingLabel: 'Verifying…',
}

// Config injected by the Liquid block into window.__PRACTITIONER_CODE_CONFIG__.
// Identity + prefill only — no UI copy, no backend URL.
//
// Shopify's Liquid `customer.id` returns the numeric id (e.g. 9500432204018),
// but the backend `find-by-customer-id` endpoint validates the input against
// /^gid:\/\/shopify\/Customer\/\d+$/ — it needs the FULL GID form. Same for
// `apply-code` which forwards `shopifyCustomerId` to Shopify Admin GraphQL
// (also GID-formatted). So we normalize numeric-only ids into the GID form
// right here — one place, both callers benefit.
function toCustomerGid(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.startsWith('gid://shopify/Customer/')) return s
  if (/^\d+$/.test(s)) return `gid://shopify/Customer/${s}`
  // Unknown format — return as-is; the backend will reject via the regex
  // and the effect falls through to the "no saved code" path.
  return s
}

function readConfig() {
  const cfg =
    (typeof window !== 'undefined' && window.__PRACTITIONER_CODE_CONFIG__) || {}
  return {
    customerId: toCustomerGid(cfg.customerId),
    customerEmail: String(cfg.customerEmail || ''),
    shopDomain: String(cfg.shopDomain || ''),
    initialCode: String(cfg.initialCode || ''),
    initialPractitionerName: String(cfg.initialPractitionerName || ''),
    initialDiscountPercent: String(cfg.initialDiscountPercent || ''),
  }
}

// discountPercent is stored everywhere (DB, cart attribute) as a FRACTION
// (0.15 = 15%), matching cdo_settings.defaultCommissionRate's convention.
// Always convert to a whole-number percent before showing it to the buyer.
function formatPct(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return ''
  return `${Math.round(fraction * 100 * 100) / 100}%`
}

async function saveCartAttributes(attributes) {
  const res = await fetch('/cart/update.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attributes }),
  })
  if (!res.ok) throw new Error('Could not save cart attributes')
  return res.json().catch(() => null)
}

// Peek at the current cart to see whether the given discount code is
// already applied in this session. Used before the auto-apply redirect
// to avoid a pointless page reload when the customer already has the
// discount active from an earlier visit.
//
// IMPORTANT: Shopify's `discount_codes` array can list a code that was
// SUBMITTED but isn't actually taking effect (`applicable: false`) — e.g.
// when a non-combinable code is added while a different one is still
// active on the cart. Matching on code name alone would falsely report
// "already applied" for a code that isn't really discounting anything.
async function isDiscountAlreadyOnCart(code) {
  try {
    const res = await fetch('/cart.json', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    })
    if (!res.ok) return false
    const cart = await res.json()
    // Shopify exposes both a flat `discount_codes` array (legacy) and a
    // newer `cart_level_discount_applications` array. Check both so the
    // check works on any theme.
    const flat = Array.isArray(cart?.discount_codes) ? cart.discount_codes : []
    const lvl = Array.isArray(cart?.cart_level_discount_applications)
      ? cart.cart_level_discount_applications
      : []
    const needle = code.toLowerCase()
    const hitFlat = flat.some(
      (dc) =>
        String(dc?.code || '').toLowerCase() === needle &&
        dc?.applicable !== false,
    )
    const hitLvl = lvl.some(
      (dc) =>
        String(dc?.code || dc?.title || '').toLowerCase() === needle &&
        dc?.applicable !== false,
    )
    return hitFlat || hitLvl
  } catch {
    return false
  }
}

// Clear any discount code currently active on the cart's checkout session.
// Shopify's discount codes act like a list under the hood — applying a new
// non-combinable code via `/discount/<code>` does NOT automatically detach
// a previously-applied one, it just gets added alongside it as inapplicable.
// We must explicitly clear the old code first so the new one actually takes
// effect. `/cart/update.js` accepts a `discount` field for exactly this.
async function clearCartDiscount() {
  try {
    await fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discount: '' }),
    })
  } catch {
    // Best-effort — if this fails, the subsequent /discount/<code> redirect
    // still runs and Shopify may still swap correctly on its own.
  }
}

// Apply a Shopify discount code to the browser session. This is the
// storefront equivalent of the checkout extension's
// `shopify.applyDiscountCodeChange({ type: 'addDiscountCode', code })`.
//
// Shopify exposes `/discount/<code>` as a native storefront endpoint —
// visiting it sets the discount on the session cookie and redirects to
// `?redirect=<path>`. That cookie then rides through to checkout, so
// the discount shows up on both cart page (refreshed) and checkout.
//
// We do a hard navigation (window.location.href) instead of a background
// fetch because:
//   (a) the redirect side-effect is the only officially-supported way to
//       populate the session cookie — background fetch works in some
//       browsers, breaks in others (Safari ITP, CORS, redirect:manual
//       oddness);
//   (b) after the redirect the cart page auto-reloads and the discount
//       becomes visible in the cart totals immediately, so the buyer
//       sees the discount BEFORE moving to checkout.
//
// Clears any existing discount FIRST (see clearCartDiscount) — swapping
// between two non-combinable practitioner codes otherwise leaves the OLD
// one as the applicable discount, since Shopify keeps both codes on the
// cart and only one non-combinable code can be applicable at a time.
async function applyDiscountToSession(code) {
  await clearCartDiscount()
  const encoded = encodeURIComponent(code)
  // ?redirect=/cart keeps the buyer on the cart page (Shopify's default
  // is /checkout). The browser hits /discount/<code>, Shopify sets the
  // session cookie, then 302s back to /cart.
  window.location.href = `/discount/${encoded}?redirect=/cart`
}

export default function App() {
  const config = useMemo(readConfig, [])
  const [code, setCode] = useState(config.initialCode)
  const [busy, setBusy] = useState(false)
  // No initial success message on mount — the reconcile effect below
  // decides the correct message (or clears stale cart attributes) after
  // resolving the customer's authoritative saved code. Trusting the raw
  // cart attributes at mount time would show a "Verified — Parker's
  // discount" message for a code the current customer isn't even bound
  // to (stale cart attributes from an earlier browser session).
  const [status, setStatus] = useState(null)
  const inputRef = useRef(null)

  // ── Reconcile cart attributes ↔ customer's saved code on mount ──────
  //
  // Cart attributes persist across sessions in Shopify. Without this
  // effect, a logged-in patient of practitioner A could see practitioner
  // B's code pre-filled in the input because an earlier browser session
  // typed it there. Rule of thumb:
  //   • Logged-in buyer  → backend `find-by-customer-id` is authoritative.
  //                        Override cart attributes if they don't match.
  //   • Guest            → trust cart attributes as-is (buyer typed them
  //                        earlier in this session).
  //
  // Also handles first-time auto-apply for returning patients (preserves
  // the old checkout-ui-code UX) and re-fires the /discount/<code>
  // session-cookie handshake when the discount isn't yet on this cart.
  //
  // Runs exactly once per mount, ref-guarded so a strict-mode remount
  // doesn't double-fire the /discount redirect.
  const reconciledRef = useRef(false)
  useEffect(() => {
    if (reconciledRef.current) return
    reconciledRef.current = true

    let cancelled = false
    ;(async () => {
      try {
        // ── 1. Resolve the AUTHORITATIVE code for this buyer ────────
        let authCode = ''
        let authName = ''
        let authPct = null

        if (config.customerId) {
          // Logged in — ask the backend. This reads the customer's
          // `code:*` Shopify tag which is the single source of truth.
          const found = await ApiService.findByCustomerId(
            config.customerId,
            config.shopDomain,
          )
          if (cancelled) return
          if (found?.found && found?.code) {
            authCode = String(found.code)
            authName = String(found.practitionerName || '')
            authPct =
              found.discountPercent != null
                ? Number(found.discountPercent)
                : null
          }
          // NOTE: no saved code → leave authCode empty. Cart attrs (if
          // any) from a previous session are considered STALE for this
          // logged-in buyer and will be cleared below.
        } else if (
          config.initialCode &&
          config.initialPractitionerName
        ) {
          // Guest — nothing authoritative to compare against. Trust the
          // cart attributes; the buyer typed them earlier this session.
          authCode = config.initialCode
          authName = config.initialPractitionerName
          // Discount% is stored on the cart as a string fraction (e.g.
          // "0.15"); parse loosely.
          const parsed = Number(config.initialDiscountPercent)
          authPct = Number.isFinite(parsed) ? parsed : null
        }

        // ── 2. Nothing to apply for this buyer → clear any stale attrs
        if (!authCode) {
          if (config.initialCode) {
            // Cart carries a code but the logged-in buyer isn't bound
            // to it. Wipe so the buyer isn't misled by a "Verified"
            // state for a code they don't own.
            await saveCartAttributes({
              cdo_practitioner_code: '',
              cdo_practitioner_name: '',
              cdo_practitioner_discount_percent: '',
            })
            if (!cancelled) {
              setCode('')
              setStatus(null)
            }
          }
          return
        }

        // ── 3. Update UI + cart attrs to match the authoritative code
        const suffixPct = formatPct(authPct)
        const suffix = suffixPct ? `${suffixPct} discount` : 'discount'
        const nameLabel = authName || 'your practitioner'

        if (!cancelled) setCode(authCode)

        if (authCode !== config.initialCode) {
          // Cart carried a different (stale) code — overwrite.
          await saveCartAttributes({
            cdo_practitioner_code: authCode,
            cdo_practitioner_name: authName,
            cdo_practitioner_discount_percent:
              authPct != null ? String(authPct) : '',
          })
          if (cancelled) return
        }

        // ── 4. Is the discount actually on this cart's session cookie?
        const already = await isDiscountAlreadyOnCart(authCode)
        if (cancelled) return

        if (already) {
          setStatus({
            tone: 'success',
            message: `✓ ${nameLabel}'s ${suffix} applied.`,
          })
          return
        }

        // Not on session yet — activate via /discount/<code> and reload.
        // Ye tab hoga:
        //   • Logged-in returning patient's first visit this session
        //   • Session cookie expired but cart attribute persisted
        //   • Buyer manually cleared discount from cart summary
        setStatus({
          tone: 'success',
          message: `✓ Applying ${nameLabel}'s ${suffix} for you…`,
        })
        applyDiscountToSession(authCode)
      } catch (err) {
        // Best-effort — auto-apply/reconcile shouldn't ever hard-fail.
        // eslint-disable-next-line no-console
        console.warn(
          '[practitioner-code] reconcile skipped:',
          err?.message,
        )
      }
    })()

    return () => {
      cancelled = true
    }
    // Runs once per mount — config values are stable snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verify = useCallback(async () => {
    const trimmed = (code || '').trim()
    if (!trimmed) {
      setStatus({ tone: 'error', message: 'Please enter a practitioner code.' })
      return
    }

    setBusy(true)
    setStatus(null)

    try {
      // 1. Validate the code via the ns-retail app proxy.
      const validation = await ApiService.verifyCode(trimmed, {
        email: config.customerEmail,
        customerId: config.customerId,
      })

      if (!validation.valid) {
        setStatus({
          tone: 'error',
          message:
            validation.message ||
            (validation.reason
              ? `Invalid code (${validation.reason})`
              : 'Invalid practitioner code.'),
        })
        setBusy(false)
        return
      }

      // 2. Save code + metadata to cart attributes so it flows to the
      //    order via note_attributes.
      const resolvedCode = validation.code || trimmed
      await saveCartAttributes({
        cdo_practitioner_code: resolvedCode,
        cdo_practitioner_name: validation.practitionerName || '',
        cdo_practitioner_discount_percent:
          validation.discountPercent != null
            ? String(validation.discountPercent)
            : '',
      })

      // 3. Logged-in buyers → tag the customer so the code becomes the
      //    default for future orders (backend tag sync). Best-effort —
      //    the actual discount application happens in step 4 via the
      //    /discount/<code> session URL, so a tag-sync failure never
      //    blocks the discount showing on the current order.
      if (config.customerId) {
        await ApiService.applyAndTagCode(
          resolvedCode,
          {
            email: config.customerEmail,
            customerId: config.customerId,
            shopifyCustomerId: config.customerId,
          },
          config.shopDomain,
        )
      }

      // 4. Apply the discount to the current browser session. This is
      //    the storefront equivalent of the old checkout extension's
      //    `shopify.applyDiscountCodeChange` call — the practitioner
      //    code IS the Shopify discount code, so visiting /discount/<code>
      //    activates it on the session cookie and Shopify auto-shows it
      //    on the cart totals + carries it into checkout.
      //
      //    Show the "success" message BEFORE the redirect so it flashes
      //    briefly (the redirect back to /cart is near-instant).
      const name = validation.practitionerName || 'your practitioner'
      const pct = formatPct(validation.discountPercent)
      const suffix = pct ? `${pct} discount` : 'discount'
      setStatus({
        tone: 'success',
        message: `✓ Verified — applying ${name}'s ${suffix}…`,
      })

      applyDiscountToSession(resolvedCode)
      // NOTE: execution effectively ends here (hard navigation). The
      // `setBusy(false)` in the `finally` block still runs but the page
      // is about to be replaced.
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[practitioner-code] verify failed:', err)
      setStatus({
        tone: 'error',
        message:
          (err && err.message) ||
          'Verification failed. Please try again in a moment.',
      })
    } finally {
      setBusy(false)
    }
  }, [code, config.customerEmail, config.customerId, config.shopDomain])

  return (
    <div className="pcf">
      <label htmlFor="pcf-input" className="pcf__label">
        {UI.label}
      </label>
      <div className="pcf__row">
        <input
          ref={inputRef}
          id="pcf-input"
          type="text"
          className="pcf__input"
          placeholder={UI.placeholder}
          value={code}
          disabled={busy}
          maxLength={64}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              verify()
            }
          }}
        />
        <button
          type="button"
          className="pcf__button"
          disabled={busy}
          onClick={verify}
        >
          {busy ? UI.verifyingLabel : UI.buttonLabel}
        </button>
      </div>
      {status && (
        <p
          className={
            status.tone === 'success'
              ? 'pcf__status pcf__status--success'
              : status.tone === 'error'
                ? 'pcf__status pcf__status--error'
                : 'pcf__status'
          }
          role={status.tone === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </p>
      )}
    </div>
  )
}
