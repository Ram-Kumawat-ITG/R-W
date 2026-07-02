// One-way practitioner sync from wholesale → retail Shopify store.
//
// Triggered by the wholesale Shopify customers/create + customers/update +
// customers/delete webhooks. Each fires its own action through this
// service, which talks directly to the retail Shopify Admin GraphQL API
// using RETAIL_ADMIN_ACCESS_TOKEN (offline access token for the retail
// store). We never go through ns-retail's HTTP layer for this — direct
// API calls keep this independent of ns-retail's uptime / tunnel URL.
//
// Three actions:
//
//   create — Mirror a wholesale practitioner to the retail store. First
//            search retail customers by email; if found, ADOPT (add the
//            wholesale-Practitioner tag, keep existing data). If not
//            found, customerCreate with minimal fields + the tag.
//
//   update — Customer name / email / phone changed on wholesale. Push
//            the same minimal-field update to the retail customer.
//
//   delete — Practitioner deleted from wholesale. SOFT-delete on retail:
//            remove wholesale-Practitioner tag, add archived-practitioner
//            tag. Customer record stays (preserves any retail order
//            history they might have as a patient).
//
// Best-effort — every call is wrapped in try/catch and logs the error.
// A retail-side failure NEVER blocks wholesale-side operations.

import WholesaleApplication from "../../models/wholesaleApplication.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retailSync.practitioner");

// Two clean tags applied to every wholesale-mirrored retail customer.
// Order doesn't matter; Shopify stores tags as a set. On soft-delete both
// are removed and ARCHIVED_TAG is added.
const PRACTITIONER_TAGS = ["practitioner", "Approved"];
const ARCHIVED_TAG = "archived-practitioner";

const API_VERSION = "2025-07";

// eslint-disable-next-line no-undef
const RETAIL_SHOP_DOMAIN = process.env.RETAIL_SHOP_DOMAIN || "";
// eslint-disable-next-line no-undef
const RETAIL_ADMIN_ACCESS_TOKEN = process.env.RETAIL_ADMIN_ACCESS_TOKEN || "";

function assertEnv() {
  if (!RETAIL_SHOP_DOMAIN || !RETAIL_ADMIN_ACCESS_TOKEN) {
    throw new Error(
      "retailSync.practitioner: missing RETAIL_SHOP_DOMAIN / RETAIL_ADMIN_ACCESS_TOKEN env vars",
    );
  }
}

async function retailGraphql(query, variables) {
  assertEnv();
  const url = `https://${RETAIL_SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": RETAIL_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`retail GraphQL ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data?.errors?.length) {
    throw new Error(
      `retail GraphQL errors: ${JSON.stringify(data.errors).slice(0, 300)}`,
    );
  }
  return data?.data;
}

const QUERY_CUSTOMER_BY_EMAIL = /* GraphQL */ `
  query FindCustomerByEmail($q: String!) {
    customers(first: 1, query: $q) {
      edges {
        node {
          id
          email
          tags
        }
      }
    }
  }
`;

const MUTATION_CUSTOMER_CREATE = /* GraphQL */ `
  mutation CreatePractitionerOnRetail($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        email
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MUTATION_CUSTOMER_UPDATE = /* GraphQL */ `
  mutation UpdatePractitionerOnRetail($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
        email
        tags
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function dedupeTags(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const trimmed = String(t || "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

function dropTag(list, tag) {
  const target = String(tag).toLowerCase();
  return (list || []).filter(
    (t) => String(t || "").trim().toLowerCase() !== target,
  );
}

function dropTags(list, tags) {
  let next = list || [];
  for (const t of tags) next = dropTag(next, t);
  return next;
}

/**
 * Sync a wholesale practitioner to the retail Shopify store.
 *
 * @param {object} args
 * @param {object} args.application  - WholesaleApplication doc (lean ok)
 * @param {'create'|'update'|'delete'} args.action
 * @returns {Promise<{ retailCustomerId: string|null, adopted: boolean }>}
 */
export async function syncPractitionerToRetail({ application, action }) {
  if (!application?.email) {
    log.warn("skip.no_email", { applicationId: application?._id });
    return { retailCustomerId: null, adopted: false };
  }
  const email = String(application.email).trim().toLowerCase();
  const firstName = application.firstName || null;
  const lastName = application.lastName || null;
  const phone = application.phone || null;

  if (action === "create") {
    return await handleCreate({ application, email, firstName, lastName, phone });
  }
  if (action === "update") {
    return await handleUpdate({ application, email, firstName, lastName, phone });
  }
  if (action === "delete") {
    return await handleDelete({ application });
  }
  throw new Error(`unknown action: ${action}`);
}

async function handleCreate({ application, email, firstName, lastName, phone }) {
  // Idempotent: if we already mirrored this practitioner, just refresh the tags.
  if (application.retailShopifyCustomerId) {
    log.info("create.already_mirrored", {
      applicationId: String(application._id),
      retailCustomerId: application.retailShopifyCustomerId,
    });
    await ensureTag(
      application.retailShopifyCustomerId,
      PRACTITIONER_TAGS,
      [ARCHIVED_TAG],
    );
    return {
      retailCustomerId: application.retailShopifyCustomerId,
      adopted: false,
    };
  }

  // 1. Try to find an existing retail customer with this email.
  const existing = await findRetailCustomerByEmail(email);

  if (existing?.id) {
    // ADOPT — add the practitioner tags, keep everything else.
    const nextTags = dedupeTags(existing.tags, PRACTITIONER_TAGS);
    const finalTags = dropTag(nextTags, ARCHIVED_TAG); // un-archive if needed
    await customerUpdate({
      id: existing.id,
      tags: finalTags,
    });
    await WholesaleApplication.updateOne(
      { _id: application._id },
      { $set: { retailShopifyCustomerId: existing.id } },
    );
    log.info("create.adopted", {
      applicationId: String(application._id),
      retailCustomerId: existing.id,
      email,
    });
    return { retailCustomerId: existing.id, adopted: true };
  }

  // 2. Not found — create fresh on retail with the tags.
  const input = {
    email,
    firstName,
    lastName,
    phone: phone || null,
    tags: PRACTITIONER_TAGS,
  };
  // Phone is optional; Shopify rejects malformed phone strings, so drop
  // it if it isn't E.164-ish. The webhook can still update later.
  if (!phone || !/^\+?[0-9\s\-().]{7,20}$/.test(phone)) {
    delete input.phone;
  }

  const data = await retailGraphql(MUTATION_CUSTOMER_CREATE, { input });
  const userErrors = data?.customerCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(
      `customerCreate userErrors: ${userErrors
        .map((e) => `${(e.field || []).join(".")}: ${e.message}`)
        .join("; ")}`,
    );
  }
  const created = data?.customerCreate?.customer;
  if (!created?.id) {
    throw new Error("customerCreate returned no customer");
  }
  await WholesaleApplication.updateOne(
    { _id: application._id },
    { $set: { retailShopifyCustomerId: created.id } },
  );
  log.info("create.new", {
    applicationId: String(application._id),
    retailCustomerId: created.id,
    email,
  });
  return { retailCustomerId: created.id, adopted: false };
}

async function handleUpdate({ application, email, firstName, lastName, phone }) {
  let retailCustomerId = application.retailShopifyCustomerId || null;

  // If we don't know the retail customer yet, fall through to create
  // (which itself adopts existing emails).
  if (!retailCustomerId) {
    log.info("update.no_mirror_falling_back_to_create", {
      applicationId: String(application._id),
    });
    return await handleCreate({
      application,
      email,
      firstName,
      lastName,
      phone,
    });
  }

  const input = {
    id: retailCustomerId,
    firstName,
    lastName,
    email,
  };
  if (phone && /^\+?[0-9\s\-().]{7,20}$/.test(phone)) input.phone = phone;

  await customerUpdate(input);
  log.info("update.applied", {
    applicationId: String(application._id),
    retailCustomerId,
    email,
  });
  return { retailCustomerId, adopted: false };
}

async function handleDelete({ application }) {
  const retailCustomerId = application.retailShopifyCustomerId || null;
  if (!retailCustomerId) {
    log.info("delete.no_mirror_nothing_to_do", {
      applicationId: String(application._id),
    });
    return { retailCustomerId: null, adopted: false };
  }

  // Soft-delete: remove the practitioner tag, add archived tag.
  const customer = await getRetailCustomerTags(retailCustomerId);
  if (!customer) {
    log.warn("delete.retail_customer_missing", {
      applicationId: String(application._id),
      retailCustomerId,
    });
    return { retailCustomerId, adopted: false };
  }
  // Remove BOTH practitioner tags ("Practitioner", "Approved") and add
  // the archived marker. The retail customer record itself stays.
  const nextTags = dedupeTags(
    dropTags(customer.tags, PRACTITIONER_TAGS),
    [ARCHIVED_TAG],
  );
  await customerUpdate({ id: retailCustomerId, tags: nextTags });
  log.info("delete.soft_deleted", {
    applicationId: String(application._id),
    retailCustomerId,
  });
  return { retailCustomerId, adopted: false };
}

async function findRetailCustomerByEmail(email) {
  const data = await retailGraphql(QUERY_CUSTOMER_BY_EMAIL, {
    q: `email:${email}`,
  });
  const node = data?.customers?.edges?.[0]?.node;
  if (!node) return null;
  return { id: node.id, email: node.email, tags: node.tags || [] };
}

async function getRetailCustomerTags(retailCustomerId) {
  const data = await retailGraphql(
    /* GraphQL */ `
      query GetRetailCustomerTags($id: ID!) {
        customer(id: $id) {
          id
          tags
        }
      }
    `,
    { id: retailCustomerId },
  );
  return data?.customer || null;
}

async function customerUpdate(input) {
  const data = await retailGraphql(MUTATION_CUSTOMER_UPDATE, { input });
  const userErrors = data?.customerUpdate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(
      `customerUpdate userErrors: ${userErrors
        .map((e) => `${(e.field || []).join(".")}: ${e.message}`)
        .join("; ")}`,
    );
  }
  return data?.customerUpdate?.customer;
}

async function ensureTag(retailCustomerId, addTags = [], removeTags = []) {
  const customer = await getRetailCustomerTags(retailCustomerId);
  if (!customer) return;
  let next = customer.tags || [];
  for (const t of removeTags) next = dropTag(next, t);
  next = dedupeTags(next, addTags);
  await customerUpdate({ id: retailCustomerId, tags: next });
}
