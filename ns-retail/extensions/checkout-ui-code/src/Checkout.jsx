import { useBuyerJourneyIntercept } from "@shopify/ui-extensions/checkout/preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import ApiService from "./services/ApiService";

const CART_ATTR_KEY = "cdo_practitioner_code";
const CODE_PATTERN = /^[a-z]+_[a-f0-9]{8}$/i;

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const inputCode = useSignal("");
  const verifyState = useSignal(
    /** @type {'idle' | 'verifying' | 'verified' | 'invalid'} */ ("idle"),
  );
  const verifyMessage = useSignal(/** @type {string | null} */ (null));
  const verifiedCode = useSignal(/** @type {string | null} */ (null));

  const applyState = useSignal(
    /** @type {'idle' | 'applying' | 'applied' | 'error'} */ ("idle"),
  );
  const applyMessage = useSignal(/** @type {string | null} */ (null));

  // One-shot guard so the auto-apply effect doesn't loop. Once we've
  // attempted auto-apply for a given customer's saved code, we never
  // retry in the same checkout session — even if the apply failed.
  const autoApplyAttempted = useSignal(false);

  // Referral-link / externally-applied code validation. A referral link
  // (https://<shop>/discount/<code>) auto-applies a practitioner code BEFORE
  // this extension mounts; these track validating that code against the
  // patient's permanent binding. `linkChecked` is the one-shot run guard;
  // `linkChecking` is true during the async check; `linkRejected` +
  // `linkMessage` hold a binding-conflict result after the code is removed.
  const linkChecked = useSignal(false);
  const linkChecking = useSignal(false);
  const linkRejected = useSignal(false);
  const linkMessage = useSignal(/** @type {string | null} */ (null));

  // Hard checkout block. Set when a referral code that is INVALID for this
  // buyer is applied to the order and we could NOT auto-remove it (e.g. the
  // removeDiscountCode call failed). While non-null, the buyer-journey
  // interceptor blocks all forward progress — including the final "Pay" step
  // — until the buyer clears the code. Holds the buyer-facing reason string.
  const referralBlockMessage = useSignal(/** @type {string | null} */ (null));

  // ── Shopify state we depend on ─────────────────────────────────────
  const canUpdateDiscounts =
    shopify?.instructions?.value?.discounts?.canUpdateDiscountCodes;

  const currentCodes = shopify?.discountCodes?.value || [];
  const previouslyAppliedCode = currentCodes
    .map((d) => d?.code || "")
    .find((c) => CODE_PATTERN.test(c));

  // shopify.buyerIdentity.customer is the correct path in checkout UI
  // extension API 2026-04 (NOT shopify.customer directly — that returns
  // undefined). Requires PCD Level 1 protected-customer-data access,
  // which is already approved in the Partner Dashboard for this app.
  const shopifyAny = /** @type {any} */ (shopify);
  const customer = shopifyAny?.buyerIdentity?.customer?.value;
  const shopDomain =
    shopifyAny?.shop?.myshopifyDomain ||
    shopifyAny?.shop?.value?.myshopifyDomain ||
    "";

  // Buyer email — used to enforce the permanent patient↔practitioner binding
  // server-side. `buyerIdentity.email` needs PCD level-2 access; the
  // logged-in customer's id (level 1) is the reliable fallback the backend
  // also accepts. Both are passed best-effort; an empty identity just skips
  // the checkout-time binding check (order ingest still enforces it).
  const buyerEmail =
    shopifyAny?.buyerIdentity?.email?.value ||
    customer?.email ||
    "";
  const identity = { email: buyerEmail, customerId: customer?.id };

  // Read appMetafields REACTIVELY in render so this component re-renders
  // (and the effect below re-fires) when Shopify finishes loading the
  // shop metafield list. Both `customer` and `appMetafields` are async
  // signals — without this guard, the effect can fire on customer.id
  // change BEFORE the metafield is populated, and ApiService throws
  // "App URL not configured" with no retry.
  const appMetafieldsValue =
    /** @type {any[]} */ (shopifyAny?.appMetafields?.value) || [];
  const hasAppUrl = appMetafieldsValue.some((/** @type {any} */ m) => {
    const inner = m?.metafield || m;
    const ns = inner?.namespace || "";
    const key = inner?.key || "";
    return (
      key === "app_url" &&
      (ns === "$app:cdo" || ns.endsWith("--cdo") || ns.endsWith(":cdo")) &&
      Boolean(inner?.value)
    );
  });

  // A practitioner code already on the checkout that we did NOT apply
  // ourselves this session — it arrived via a referral link
  // (https://<shop>/discount/<code>) or Shopify's native discount box. The
  // referral-link effect below validates it against the patient's permanent
  // binding before letting it stand.
  const externalCode =
    previouslyAppliedCode &&
    (!verifiedCode.value ||
      String(verifiedCode.value).toLowerCase() !==
        String(previouslyAppliedCode).toLowerCase())
      ? previouslyAppliedCode
      : null;

  // We can validate an externally-applied code whenever we can reach the
  // backend and modify discounts — buyer identity is NOT required for the
  // code-validity checks (unknown / inactive / missing-practitioner). The
  // permanent-binding check additionally needs identity, but that is enforced
  // server-side and simply skipped when identity is absent (e.g. a guest).
  // `linkPending` is true from the FIRST render an external code is seen until
  // the effect fires (derived, so there's no "applied" flash); `linkChecking`
  // covers the async window afterwards. Both keep checkout blocked meanwhile.
  const canValidate = canUpdateDiscounts !== false && hasAppUrl;
  const linkPending =
    Boolean(externalCode) && canValidate && !linkChecked.value;
  const showValidating =
    !linkRejected.value && (linkPending || linkChecking.value);

  const isApplied =
    !linkRejected.value &&
    !showValidating &&
    !referralBlockMessage.value &&
    (applyState.value === "applied" || Boolean(previouslyAppliedCode));
  const appliedCodeDisplay =
    applyState.value === "applied"
      ? verifiedCode.value
      : previouslyAppliedCode || "";

  // ── Checkout gate (single source of truth) ─────────────────────────
  // Non-null ⇒ checkout must be blocked and the string is the buyer-facing
  // reason. Recomputed every render so the interceptor (which reads the
  // latest closure via a ref) always reflects current state. Covers:
  //   1. a bad applied code we couldn't auto-remove (referralBlockMessage);
  //   2. an external/applied code still being validated (showValidating);
  //   3. an invalid code left in the manual-entry box.
  let referralBlock = null;
  if (referralBlockMessage.value) {
    referralBlock = referralBlockMessage.value;
  } else if (showValidating) {
    referralBlock =
      "Please wait while we validate your referral code, then try again.";
  } else if (
    verifyState.value === "invalid" &&
    String(inputCode.value || "").trim()
  ) {
    referralBlock = `${
      verifyMessage.value || "Invalid referral code."
    } Please enter a valid code or clear the field to continue.`;
  }

  // ── Auto-apply for logged-in customers (PATH 1 only) ───────────────
  //
  // Shopify's checkout UI extension API does NOT expose customer.tags
  // (documented limitation since July 2024). So we can't read the
  // "code:<x>" tag in the extension directly. Instead: send the customer
  // GID + shop domain to our backend, which queries the customer's tags
  // via Shopify Admin GraphQL and extracts the code. Backend then
  // re-validates the code is still active in cdo_practitioner_codes
  // before returning it.
  //
  // Manual entry via the Verify button still works as a fallback.
  useEffect(() => {
    if (autoApplyAttempted.value) return;
    if (isApplied) return;
    // A referral-link / native discount code is present — the referral-link
    // validation effect owns it; don't race it with the saved-code apply.
    if (externalCode) return;
    if (canUpdateDiscounts === false) return;

    const customerId = customer?.id;
    if (!customerId || !shopDomain) return;

    // Wait for the app-url metafield to finish loading. Without this guard
    // the effect can fire before shopify.appMetafields populates, and
    // ApiService.getAppBaseUrl() throws "App URL not configured" with no
    // automatic retry path.
    if (!hasAppUrl) return;

    autoApplyAttempted.value = true;
    autoApplyFromCustomerId(String(customerId), String(shopDomain)).catch(
      (err) => {
        console.warn(
          "[checkout-ui-code] auto-apply (customer-id path) error:",
          err,
        );
      },
    );
    // Re-fires when EITHER customer identity changes (e.g. late login) OR
    // the app-url metafield finishes loading after the customer signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id, hasAppUrl]);

  // ── Referral-link / external-code validation (permanent binding) ────
  //
  // A referral link applies the practitioner's discount code to the checkout
  // before this extension mounts; Shopify's native discount box can do the
  // same. We enforce the SAME permanent binding on that code: if the patient
  // is already associated with a DIFFERENT practitioner, the code is removed
  // from the order and a validation message is shown — an existing
  // relationship is never overwritten by a foreign link. A code matching the
  // bound practitioner (or a brand-new patient with no binding yet) is left
  // applied; the relationship is created / kept at order ingest server-side.
  useEffect(() => {
    if (linkChecked.value) return;
    if (!externalCode) return;
    if (canUpdateDiscounts === false) return;
    if (!hasAppUrl) return;
    // NOTE: identity is intentionally NOT required here. Code-validity checks
    // (unknown / inactive / missing-practitioner) run for everyone, including
    // guests; the permanent-binding check inside the endpoint is skipped when
    // no identity is supplied (and re-enforced at order ingest server-side).

    linkChecked.value = true;
    validateLinkCode(String(externalCode)).catch((err) => {
      console.warn("[checkout-ui-code] referral-link validation error:", err);
      linkChecking.value = false;
    });
    // Re-evaluates as the external code, app-url, or customer identity load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalCode, hasAppUrl, customer?.id]);

  // ── Block checkout while any referral validation is unresolved ──────
  // The order may only be created when every referral check passes. The
  // interceptor reads `referralBlock` (recomputed each render; the hook keeps
  // the latest closure in a ref) and prevents the buyer from advancing past
  // the current step — including the final "Pay" step — until it clears. If
  // the merchant hasn't granted the block_progress capability, Shopify treats
  // `block` as `allow`; our in-extension banners still surface the reason.
  useBuyerJourneyIntercept(({ canBlockProgress }) => {
    if (canBlockProgress && referralBlock) {
      return {
        behavior: "block",
        reason: "Referral code validation failed",
        errors: [{ message: referralBlock }],
      };
    }
    return { behavior: "allow" };
  });

  /**
   * PATH 1 helper — call our backend to read the customer's `code:*` tag
   * via Shopify Admin GraphQL, then apply via the same flow as manual
   * entry (so UI feedback is consistent).
   *
   * @param {string} customerId  full GID like "gid://shopify/Customer/123"
   * @param {string} shop        myshopify domain
   */
  async function autoApplyFromCustomerId(customerId, shop) {
    let result;
    try {
      result = await ApiService.findByCustomerId(customerId, shop);
    } catch (err) {
      console.warn("[checkout-ui-code] findByCustomerId failed:", err);
      autoApplyAttempted.value = false; // let it retry if a retry happens later
      return;
    }
    if (!result?.found || !result.code) {
      // Customer has no code:* tag (or tag points to inactive code).
      // Leave UI in default "enter a code" state — manual entry still works.
      return;
    }
    await autoApplyFromTag(result.code);
  }

  async function autoApplyFromTag(code) {
    inputCode.value = code;
    verifyState.value = "verifying";
    verifyMessage.value = null;

    let result;
    try {
      result = await ApiService.verifyCode(code, identity);
    } catch (err) {
      console.warn("[checkout-ui-code] auto-verify failed:", err);
      verifyState.value = "idle";
      verifyMessage.value = null;
      return;
    }

    if (!result?.valid) {
      // Saved code no longer in the catalog — practitioner may have been
      // archived. Reset cleanly so the customer can enter a new code.
      verifyState.value = "idle";
      verifyMessage.value = null;
      inputCode.value = "";
      return;
    }

    const confirmedCode = result.code || code;
    verifyState.value = "verified";
    verifiedCode.value = confirmedCode;
    verifyMessage.value = result.practitionerName
      ? `Verified — ${result.practitionerName}`
      : "Verified";

    // Immediately apply.
    applyState.value = "applying";
    applyMessage.value = null;
    try {
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CART_ATTR_KEY,
        value: confirmedCode,
      });
      const applyResult = await shopify.applyDiscountCodeChange({
        type: "addDiscountCode",
        code: confirmedCode,
      });
      if (applyResult?.type === "success") {
        applyState.value = "applied";
        applyMessage.value = `${confirmedCode} applied`;
        // Customer tagging happens AFTER order is placed via the orders/create webhook.
      } else {
        applyState.value = "error";
        applyMessage.value =
          "Couldn't apply your saved discount. Please ask the store admin to set up the matching Shopify discount.";
      }
    } catch (err) {
      console.warn("[checkout-ui-code] auto-apply failed:", err);
      applyState.value = "error";
      applyMessage.value = "Auto-apply failed. Please try the Verify button.";
    }
  }

  // Validate a referral-link / externally-applied code. A code that is valid
  // for this buyer (active, practitioner exists, and either matching the
  // existing binding or a first-time patient) is left applied. ANY invalid
  // result — unknown/inactive code, missing practitioner, or a binding
  // conflict — is removed and a message shown; if it can't be removed, the
  // checkout is hard-blocked via `referralBlockMessage` until the buyer clears it.
  async function validateLinkCode(code) {
    linkChecking.value = true;
    let result;
    try {
      result = await ApiService.verifyCode(code, identity);
    } catch (err) {
      console.warn("[checkout-ui-code] referral-link verify failed:", err);
      // Network / transient error — don't trap the buyer at checkout; the
      // orders/create ingest re-validates and corrects attribution server-side.
      referralBlockMessage.value = null;
      linkChecking.value = false;
      return;
    }

    // Valid for THIS buyer: same practitioner as an existing binding, or a
    // first-time / no-binding patient, AND the code is active + its
    // practitioner exists. Leave the discount applied; checkout proceeds.
    // Stamp the cart attribute so the webhook extracts this code from
    // note_attributes instead of falling back to the customer's saved tag.
    if (result?.valid) {
      const confirmedCode = result.code || code;
      try {
        await shopify.applyAttributeChange({
          type: "updateAttribute",
          key: CART_ATTR_KEY,
          value: confirmedCode,
        });
      } catch (err) {
        console.warn("[checkout-ui-code] cart-attr stamp failed for referral link:", err);
      }
      referralBlockMessage.value = null;
      linkChecking.value = false;
      return;
    }

    // Invalid for this buyer/order — covers every failure mode: unknown or
    // inactive/paused code (not_found), missing practitioner
    // (practitioner_missing), and permanent-binding conflict (bound_other).
    // Surface the specific reason and try to clear the offending code +
    // attribute so checkout can complete cleanly (no foreign/invalid
    // attribution). If we can't remove it, hard-block until the buyer does.
    const message = result?.message || referralMessageForReason(result?.reason);

    let removed = false;
    try {
      const removeResult = await shopify.applyDiscountCodeChange({
        type: "removeDiscountCode",
        code,
      });
      removed = removeResult?.type === "success";
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CART_ATTR_KEY,
        value: "",
      });
    } catch (err) {
      console.warn("[checkout-ui-code] referral-link remove failed:", err);
      removed = false;
    }

    linkRejected.value = true;
    linkMessage.value = message;

    if (removed) {
      // Resolved automatically — the bad code is gone, checkout may proceed.
      referralBlockMessage.value = null;
    } else {
      // Still applied — HARD BLOCK until the buyer removes it themselves.
      referralBlockMessage.value = `${message} Please remove the code "${code}" to continue.`;
    }
    linkChecking.value = false;
  }

  // Fallback buyer-facing message for a validation reason. The backend
  // normally sends an explicit `message`; this only fills gaps.
  function referralMessageForReason(/** @type {string | undefined} */ reason) {
    switch (reason) {
      case "not_found":
        return "This referral code is invalid.";
      case "practitioner_missing":
        return "The practitioner for this referral code no longer exists.";
      case "bound_other":
        return "You are already associated with another practitioner.";
      default:
        return "This referral code can't be used.";
    }
  }

  async function handleVerify() {
    const code = String(inputCode.value || "").trim();
    if (!code) {
      verifyState.value = "invalid";
      verifyMessage.value = "Please enter a code first.";
      return;
    }
    verifyState.value = "verifying";
    verifyMessage.value = null;
    try {
      const result = await ApiService.verifyCode(code, identity);
      if (result?.valid) {
        verifyState.value = "verified";
        verifiedCode.value = result.code || code;
        verifyMessage.value = result.practitionerName
          ? `Verified — ${result.practitionerName}`
          : "Verified";
      } else {
        verifyState.value = "invalid";
        // Surface the backend's specific reason — "Invalid Referral Code",
        // "Practitioner does not exist", or "You are already associated with
        // another practitioner" (permanent-binding block).
        verifyMessage.value = result?.message || "Invalid Referral Code";
      }
    } catch (err) {
      console.warn("[checkout-ui-code] verify failed:", err);
      verifyState.value = "invalid";
      const errMessage = err instanceof Error ? err.message : null;
      verifyMessage.value =
        errMessage || "Could not verify code. Please try again.";
    }
  }

  async function handleApply() {
    const code = verifiedCode.value;
    if (!code) return;
    applyState.value = "applying";
    applyMessage.value = null;
    try {
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CART_ATTR_KEY,
        value: code,
      });
      const result = await shopify.applyDiscountCodeChange({
        type: "addDiscountCode",
        code,
      });
      if (result?.type === "success") {
        applyState.value = "applied";
        applyMessage.value = `${code} applied`;
        // Customer tagging happens AFTER order is placed via the orders/create webhook.
      } else {
        applyState.value = "error";
        applyMessage.value =
          "Couldn't apply discount. Please ask the store admin to set up a matching discount in Shopify.";
      }
    } catch (err) {
      console.warn("[checkout-ui-code] apply failed:", err);
      applyState.value = "error";
      applyMessage.value = "Apply failed. Please try again.";
    }
  }

  async function handleRemove() {
    const code = verifiedCode.value || appliedCodeDisplay;
    if (!code) return;
    let removed = false;
    try {
      const removeResult = await shopify.applyDiscountCodeChange({
        type: "removeDiscountCode",
        code,
      });
      removed = removeResult?.type === "success";
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CART_ATTR_KEY,
        value: "",
      });
    } catch (err) {
      console.warn("[checkout-ui-code] remove failed:", err);
      removed = false;
    }
    if (!removed) {
      // Couldn't remove the code — keep checkout blocked and tell the buyer
      // how to clear it (Shopify's native discount field).
      referralBlockMessage.value = `We couldn't remove the code "${code}". Please remove it from the discount field to continue.`;
      return;
    }
    inputCode.value = "";
    verifyState.value = "idle";
    verifyMessage.value = null;
    verifiedCode.value = null;
    applyState.value = "idle";
    applyMessage.value = null;
    referralBlockMessage.value = null;
    linkRejected.value = false;
    linkMessage.value = null;
  }

  function handleInputChange(/** @type {Event} */ e) {
    const target = /** @type {HTMLInputElement | null} */ (e?.target);
    const next = target?.value ?? "";
    inputCode.value = next;
    if (verifyState.value !== "idle") {
      verifyState.value = "idle";
      verifyMessage.value = null;
      verifiedCode.value = null;
    }
  }

  // ── Render: validating a referral-link / external code ────────────
  if (showValidating) {
    return (
      <s-banner heading="Practitioner discount">
        <s-stack direction="inline" gap="small-200">
          <s-text>Validating your referral link…</s-text> <s-spinner />
        </s-stack>
      </s-banner>
    );
  }

  // ── Render: blocked — an invalid code is still applied and couldn't be
  // auto-removed. Checkout is blocked (via the interceptor) until the buyer
  // removes it here. ────────────────────────────────────────────────
  if (referralBlockMessage.value) {
    return (
      <s-banner heading="Practitioner discount" tone="critical">
        <s-stack gap="base">
          <s-text>{referralBlockMessage.value}</s-text>
          <s-button variant="primary" onClick={handleRemove}>
            Remove code
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  // ── Render: applied state (success, with Remove button) ───────────
  if (isApplied) {
    return (
      <s-banner heading="Practitioner discount" tone="success">
        <s-stack gap="base">
          <s-text>
            <s-text type="strong">{appliedCodeDisplay}</s-text> applied to your
            order.
          </s-text>
          <s-button variant="primary" onClick={handleRemove}>
            Remove
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  // ── Render: discounts blocked (Apple Pay / Google Pay / scripts) ──
  if (canUpdateDiscounts === false) {
    return (
      <s-banner heading="Practitioner discount" tone="warning">
        <s-text>
          Discount codes can't be applied right now. Try removing accelerated
          checkout (Apple Pay / Google Pay) and reload.
        </s-text>
      </s-banner>
    );
  }

  const isAutoFlow =
    autoApplyAttempted.value &&
    (verifyState.value === "verifying" || applyState.value === "applying");
  if (isAutoFlow) {
    return (
      <s-banner heading="Practitioner discount">
        <s-stack direction="inline" gap="small-200">
          <s-text>Applying your saved discount…</s-text> <s-spinner />
        </s-stack>
      </s-banner>
    );
  }

  // ── Render: default — input + Verify → Apply ──────────────────────
  return (
    <s-banner heading="Have a practitioner code?">
      <s-stack gap="base">
        <s-text>
          Enter your practitioner's referral code to apply your discount.
        </s-text>

        {/* Referral-link rejection — the link belonged to a different
            practitioner than the one this patient is permanently associated
            with, so it was removed. They can still enter a code from their
            own practitioner below. */}
        {linkRejected.value && linkMessage.value && (
          <s-text tone="critical">{linkMessage.value}</s-text>
        )}

        <s-grid gridTemplateColumns="1fr auto" gap="small-200" alignItems="end">
          <s-text-field
            label="Practitioner code"
            value={inputCode.value}
            onChange={handleInputChange}
            placeholder="e.g. john_a3f1c8e2"
            disabled={
              verifyState.value === "verifying" ||
              applyState.value === "applying"
            }
          />

          {verifyState.value !== "verified" && (
            <s-button
              variant="primary"
              onClick={handleVerify}
              loading={verifyState.value === "verifying"}
              disabled={!String(inputCode.value || "").trim()}
            >
              Verify
            </s-button>
          )}

          {verifyState.value === "verified" && (
            <s-button
              variant="primary"
              onClick={handleApply}
              loading={applyState.value === "applying"}
            >
              Apply discount
            </s-button>
          )}
        </s-grid>

        {verifyState.value === "verified" && verifyMessage.value && (
          <s-text tone="success">{verifyMessage.value}</s-text>
        )}
        {verifyState.value === "invalid" && verifyMessage.value && (
          <s-text tone="critical">{verifyMessage.value}</s-text>
        )}
        {applyState.value === "error" && applyMessage.value && (
          <s-text tone="critical">{applyMessage.value}</s-text>
        )}
      </s-stack>
    </s-banner>
  );
}
