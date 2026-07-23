// Cart/checkout validation: block checkout when the buyer (practitioner) is on
// a payment order hold. The hold signal is the app-owned customer metafield
// $app:wholesale.order_hold (value "held"), kept in sync by the app. Returns a
// validation error (which prevents the order from being placed) with the
// support message; otherwise no operations (checkout proceeds).
//
// Plain JS (no generated types imported) so the run is self-contained. Run
// `npm run typegen` after `shopify app function schema` if you want the typed
// RunInput/Result while editing.

const NO_CHANGES = { operations: [] };

const BLOCK_MESSAGE =
  "You have an outstanding invoice payment. Please pay your existing invoice before placing a new order. If you need assistance, please contact our support team.";

export function cartValidationsGenerateRun(input) {
  const held = input?.cart?.buyerIdentity?.customer?.orderHold?.value;
  // Metafield absent (null) or not the "held" sentinel ⇒ allow checkout.
  if (!held || String(held).toLowerCase() !== "held") {
    return NO_CHANGES;
  }

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message: BLOCK_MESSAGE,
              // Cart-level error → surfaced at checkout, blocks completion.
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}
