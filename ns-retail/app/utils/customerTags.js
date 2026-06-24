import { unauthenticated } from "../shopify.server";

// Look up a Shopify customer by email and return their GraphQL ID.
// Returns null if not found.
export async function lookupCustomerByEmail(shop, email) {
  if (!shop || !email) {
    throw new Error("shop and email are required");
  }

  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(
    `query FindCustomer($email: String!) {
      customers(first: 1, query: $email) {
        edges {
          node { id email }
        }
      }
    }`,
    { variables: { email: String(email).toLowerCase().trim() } },
  );

  const data = await res.json();
  const customers = data?.data?.customers?.edges || [];
  if (customers.length === 0) return null;

  return customers[0].node.id;
}

// Apply/update the `code:<referralCode>` tag on a Shopify customer.
// Removes old code tags and adds the new one, preserving other tags.
export async function syncCustomerCodeTag(shop, customerGid, newCode, practitionerEmail = null) {
  if (!shop || !customerGid || !newCode) {
    throw new Error("shop, customerGid, and newCode are required");
  }

  const newCodeTag = `code:${newCode}`;
  const emailTag = practitionerEmail
    ? String(practitionerEmail).toLowerCase().trim()
    : null;

  const { admin } = await unauthenticated.admin(shop);

  // Fetch existing tags
  const res = await admin.graphql(
    `query GetCustomerTags($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    { variables: { id: customerGid } },
  );
  const data = await res.json();
  const existing = data?.data?.customer?.tags || [];

  // Remove old code tags (code:*) and email tags if needed.
  // Case-insensitive so "CODE:test15", "code:test15" etc. are all cleaned up.
  const filtered = existing.filter((tag) => {
    if (tag.toLowerCase().startsWith("code:")) return false;
    if (emailTag && tag.toLowerCase() === emailTag.toLowerCase()) return false;
    return true;
  });

  // Add new code tag and email tag
  const toAdd = [];
  if (!filtered.includes(newCodeTag)) toAdd.push(newCodeTag);
  if (emailTag && !filtered.includes(emailTag)) toAdd.push(emailTag);

  const final = [...filtered, ...toAdd];

  // Skip update if tags unchanged
  if (JSON.stringify(final.sort()) === JSON.stringify(existing.sort())) {
    console.log(`[customerTags] tags already current on ${customerGid}`);
    return;
  }

  const updRes = await admin.graphql(
    `mutation UpdateCustomerTags($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id tags }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: customerGid, tags: final } } },
  );

  const updData = await updRes.json();
  const errs = updData?.data?.customerUpdate?.userErrors || [];
  if (errs.length) {
    throw new Error(`customerUpdate failed: ${errs.map((e) => e.message).join("; ")}`);
  }

  console.log(`[customerTags] updated ${customerGid}: removed old code tags, added ${newCodeTag}`);
}

// Resolve a customer's referral code from Shopify tags.
// Returns the code from the first `code:*` tag found, or null.
export async function resolveCustomerCodeFromTag(shop, customerGid) {
  if (!shop || !customerGid) {
    throw new Error("shop and customerGid are required");
  }

  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(
    `query GetCustomerTags($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    { variables: { id: customerGid } },
  );
  const data = await res.json();
  const tags = data?.data?.customer?.tags || [];

  // Find the code:* tag (case-insensitive — we write lowercase but external
  // tools or Shopify admin may have mixed case).
  const codeTag = tags.find((tag) => tag.toLowerCase().startsWith("code:"));
  if (!codeTag) return null;

  return codeTag.substring(5).trim(); // Remove "code:" prefix
}
