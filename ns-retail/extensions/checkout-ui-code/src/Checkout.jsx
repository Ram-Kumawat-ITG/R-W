import "@shopify/ui-extensions/preact";
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

  const isApplied =
    applyState.value === "applied" || Boolean(previouslyAppliedCode);
  const appliedCodeDisplay =
    applyState.value === "applied"
      ? verifiedCode.value
      : previouslyAppliedCode || "";

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
      result = await ApiService.verifyCode(code);
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
      const result = await ApiService.verifyCode(code);
      if (result?.valid) {
        verifyState.value = "verified";
        verifiedCode.value = result.code || code;
        verifyMessage.value = result.practitionerName
          ? `Verified — ${result.practitionerName}`
          : "Verified";
      } else {
        verifyState.value = "invalid";
        verifyMessage.value = "Code not found.";
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
    try {
      await shopify.applyDiscountCodeChange({
        type: "removeDiscountCode",
        code,
      });
      await shopify.applyAttributeChange({
        type: "updateAttribute",
        key: CART_ATTR_KEY,
        value: "",
      });
    } catch (err) {
      console.warn("[checkout-ui-code] remove failed:", err);
    }
    inputCode.value = "";
    verifyState.value = "idle";
    verifyMessage.value = null;
    verifiedCode.value = null;
    applyState.value = "idle";
    applyMessage.value = null;
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
