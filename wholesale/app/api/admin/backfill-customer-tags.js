// One-time admin endpoint to add the "Approved" tag to every existing
// customer in the wholesale store.
//
// Why this exists: when the customers/create webhook is enabled, any
// customer WITHOUT the Approved tag gets auto-deleted (if they have no
// orders) or flagged unauthorized (if they have orders). Customers that
// existed BEFORE this rule was deployed will not have the Approved tag,
// so this script applies the tag retroactively to prevent the webhook
// from later misclassifying them.
//
// Safe to run multiple times — already-tagged customers are skipped.

import { authenticate } from "../../shopify.server";
import { sendResponse } from "../../services/APIService/api.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.admin.backfill_customer_tags");

const APPROVED_TAG = "Approved";

const QUERY_CUSTOMERS_PAGE = `#graphql
  query CustomersPage($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      edges {
        node {
          id
          email
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const MUTATION_TAGS_ADD = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

function hasApproved(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(
    (t) => String(t).trim().toLowerCase() === APPROVED_TAG.toLowerCase(),
  );
}

// POST /api/admin/backfill-customer-tags
export async function action({ request }) {
  if (request.method !== "POST") {
    return sendResponse(405, "error", "Method not allowed", null);
  }

  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  log.info("backfill.start", { shop });

  const results = {
    totalScanned: 0,
    alreadyTagged: 0,
    tagged: 0,
    failed: 0,
    errors: [],
  };

  let hasNextPage = true;
  let after = null;
  const PAGE_SIZE = 100; // keep cost well under 1000

  try {
    while (hasNextPage) {
      const res = await admin.graphql(QUERY_CUSTOMERS_PAGE, {
        variables: { first: PAGE_SIZE, after },
      });
      const json = await res.json();
      const data = json?.data?.customers;
      if (!data) {
        log.error("backfill.graphql_no_data", { shop, json });
        return sendResponse(
          502,
          "error",
          "GraphQL returned no customers data",
          { json },
        );
      }

      for (const edge of data.edges || []) {
        results.totalScanned += 1;
        const customer = edge.node;
        if (!customer?.id) continue;

        if (hasApproved(customer.tags)) {
          results.alreadyTagged += 1;
          continue;
        }

        try {
          const tagRes = await admin.graphql(MUTATION_TAGS_ADD, {
            variables: { id: customer.id, tags: [APPROVED_TAG] },
          });
          const tagJson = await tagRes.json();
          const userErrors = tagJson?.data?.tagsAdd?.userErrors || [];
          if (userErrors.length) {
            results.failed += 1;
            results.errors.push({
              customerId: customer.id,
              email: customer.email,
              userErrors,
            });
            log.error("backfill.tag_failed", {
              customerId: customer.id,
              email: customer.email,
              userErrors,
            });
            continue;
          }
          results.tagged += 1;
          log.info("backfill.tagged", {
            customerId: customer.id,
            email: customer.email,
          });
        } catch (err) {
          results.failed += 1;
          results.errors.push({
            customerId: customer.id,
            email: customer.email,
            error: err?.message || String(err),
          });
          log.error("backfill.tag_threw", {
            customerId: customer.id,
            email: customer.email,
            err: err?.message || String(err),
          });
        }
      }

      hasNextPage = data.pageInfo?.hasNextPage ?? false;
      after = data.pageInfo?.endCursor ?? null;
    }
  } catch (err) {
    log.error("backfill.fatal", { shop, err: err?.message || String(err) });
    return sendResponse(500, "error", "Backfill failed", {
      err: err?.message || String(err),
      results,
    });
  }

  log.info("backfill.done", { shop, ...results });
  return sendResponse(
    200,
    "success",
    `Backfill complete: ${results.tagged} tagged, ${results.alreadyTagged} already tagged, ${results.failed} failed`,
    results,
  );
}

export async function loader() {
  return sendResponse(405, "error", "Method not allowed", null);
}
