import { unauthenticated } from "../shopify.server";

// Enforcement-layer metafields for the practitioner-discount system.
//
// Tags (see customerTags.js) are the human-readable / reporting record of a
// customer's practitioner association. These metafields are the copy the
// `practitioner-discount` Shopify Function actually reads at checkout-time
// to decide whether a practitioner-specific discount code is allowed —
// Functions read live values with no propagation lag, unlike Customer
// Segments (which recompute on a schedule and are unusable for a
// verify-then-immediately-checkout flow).
//
// Namespace: plain "cdo" (not "$app:cdo" — that alias only resolves from
// inside this app's own extension/theme-code context; a backend Admin API
// call must use the literal namespace).
const NAMESPACE = "cdo";
const CUSTOMER_KEY = "practitioner_id";

// Read a customer's PERMANENT practitioner association, if any.
// Returns the practitionerId string, or null if unbound.
export async function getCustomerPractitionerBinding(shop, customerGid) {
  if (!shop || !customerGid) return null;

  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(
    `query GetCustomerPractitionerMetafield($id: ID!, $namespace: String!, $key: String!) {
      customer(id: $id) {
        metafield(namespace: $namespace, key: $key) { value }
      }
    }`,
    { variables: { id: customerGid, namespace: NAMESPACE, key: CUSTOMER_KEY } },
  );
  const data = await res.json();
  const value = data?.data?.customer?.metafield?.value;
  return value ? String(value) : null;
}

// Permanently bind a customer to a practitioner via metafield — write-once.
// If the customer already carries a DIFFERENT practitionerId, this is a
// no-op — the binding is permanent by design and a mismatch here should
// already have been blocked upstream by the discount Function before an
// order with a foreign code could even be placed. Callers should still log
// `mismatch: true` results — a mismatch reaching this point means the code
// was applied through a path the Function didn't gate (e.g. manually in
// Shopify Admin).
export async function bindCustomerToPractitioner(shop, customerGid, practitionerId) {
  if (!shop || !customerGid || !practitionerId) {
    throw new Error("shop, customerGid, and practitionerId are required");
  }

  const existing = await getCustomerPractitionerBinding(shop, customerGid);
  if (existing) {
    const mismatch = String(existing) !== String(practitionerId);
    return { ok: true, alreadyBound: true, mismatch, practitionerId: existing };
  }

  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(
    `mutation SetCustomerPractitionerMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: customerGid,
            namespace: NAMESPACE,
            key: CUSTOMER_KEY,
            type: "single_line_text_field",
            value: String(practitionerId),
          },
        ],
      },
    },
  );
  const data = await res.json();
  const errs = data?.data?.metafieldsSet?.userErrors || [];
  if (errs.length) {
    throw new Error(`metafieldsSet failed: ${errs.map((e) => e.message).join("; ")}`);
  }
  return { ok: true, alreadyBound: false, practitionerId };
}
