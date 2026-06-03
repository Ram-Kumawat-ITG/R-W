import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import ApiService from "./services/ApiService";


const CART_ATTR_KEY = "cdo_practitioner_code";
const CODE_PATTERN = /^[a-z]+_[a-f0-9]{8}$/i;
const CUSTOMER_TAG_PREFIX = "code:";

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

  const customer = shopify?.customer?.value;

  const isApplied =
    applyState.value === "applied" || Boolean(previouslyAppliedCode);
  const appliedCodeDisplay =
    applyState.value === "applied"
      ? verifiedCode.value
      : previouslyAppliedCode || "";

  // ── Auto-apply for logged-in customers ─────────────────────────────
  // If the customer is logged in and has a "code:<code>" tag on their
  // Shopify customer record (from signup form or a previous order's
  // webhook), pre-fill the input, verify the code is still valid, and
  // apply it automatically. The customer never has to type anything.
  useEffect(() => {
    if (autoApplyAttempted.value) return;
    if (!customer) return;
    if (isApplied) return;
    if (canUpdateDiscounts === false) return;

    const tags = Array.isArray(customer.tags) ? customer.tags : [];
    const codeTag = tags.find(
      (t) =>
        typeof t === "string" &&
        t.toLowerCase().startsWith(CUSTOMER_TAG_PREFIX),
    );
    if (!codeTag) return;

    const code = String(codeTag).slice(CUSTOMER_TAG_PREFIX.length).trim();
    if (!code) return;

    autoApplyAttempted.value = true;
    autoApplyFromTag(code).catch((err) => {
      console.warn("[checkout-ui-code] auto-apply error:", err);
    });
    // Re-run only when the customer identity changes (e.g. late login).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

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
        <s-text>Applying your saved discount…</s-text>
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

        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-200"
          alignItems="end"
        >
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
