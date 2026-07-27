// @ts-check

// Cart/checkout validation: block checkout for a practitioner who is on a
// PAYMENT order hold (an outstanding failed invoice — card retries exhausted).
//
// The hold signal is the app-owned customer metafield $app:wholesale.order_hold
// (value "held"), kept in sync by the app (services/order/orderHold.service.js).
// Functions can't call our DB/API, so this metafield is the bridge. Absent /
// not "held" ⇒ no error, checkout proceeds; "held" ⇒ a cart-level validation
// error that prevents the order from being placed, with the support message.

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const BLOCK_MESSAGE =
  "You have an outstanding invoice payment. Please pay your existing invoice before placing a new order. If you need assistance, please contact our support team.";

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const held = input.cart.buyerIdentity?.customer?.orderHold?.value;

  // Only block on the explicit "held" sentinel; absent/empty ⇒ allow.
  if (!held || String(held).toLowerCase() !== "held") {
    return { operations: [] };
  }

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message: BLOCK_MESSAGE,
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}
