import {
  DiscountClass,
  OrderDiscountSelectionStrategy,
} from '../generated/api';

/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

const NO_DISCOUNT = { operations: [] };

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) return NO_DISCOUNT;

  const hasOrderDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Order,
  );
  if (!hasOrderDiscountClass) return NO_DISCOUNT;

  const configRaw = input.discount.config?.value;
  if (!configRaw) return NO_DISCOUNT;

  let config;
  try {
    config = JSON.parse(configRaw);
  } catch {
    return NO_DISCOUNT;
  }

  // percentage is stored as a fraction (0.15 = 15%); Shopify's discount
  // value wants a whole-number percent.
  const percentage = Number(config?.percentage);
  const practitionerId = config?.practitionerId
    ? String(config.practitionerId)
    : null;
  if (
    !Number.isFinite(percentage) ||
    percentage <= 0 ||
    percentage > 1 ||
    !practitionerId
  ) {
    return NO_DISCOUNT;
  }

  const boundPractitionerId =
    input.cart.buyerIdentity?.customer?.practitionerBinding?.value
      ? String(input.cart.buyerIdentity.customer.practitionerBinding.value)
      : null;

  // Buyer is permanently bound to a DIFFERENT practitioner than the one who
  // owns this code — decline. Shopify shows the code as not applicable; no
  // discount lines are added.
  if (boundPractitionerId && boundPractitionerId !== practitionerId) {
    return NO_DISCOUNT;
  }

  // Allowed: unbound (first-time) buyer, or bound to the SAME practitioner.
  // The permanent binding write happens server-side after order placement
  // (see webhooks.orders.create.jsx) — this Function only ever reads.
  const percent = Math.round(percentage * 100);
  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: `${percent}% OFF`,
              targets: [
                {
                  orderSubtotal: {
                    excludedCartLineIds: [],
                  },
                },
              ],
              value: {
                percentage: {
                  value: percent,
                },
              },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      },
    ],
  };
}
