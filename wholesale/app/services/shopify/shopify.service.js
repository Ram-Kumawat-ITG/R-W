// Shopify domain methods — what the rest of the app uses to talk to
// the Admin API. Combines order updates, webhook subscription management,
// customer lifecycle, and file uploads.
//
// All GraphQL strings are in shopify.queries.js / shopify.mutations.js.
// All low-level admin-client plumbing is in shopify.apis.js.

// Carries structured Shopify userErrors so callers can map fields back to form inputs.
export class ShopifyUserError extends Error {
  constructor(userErrors) {
    super(
      userErrors
        .map(
          (e) =>
            `[${Array.isArray(e.field) ? e.field.join(".") : e.field}] ${e.message}`,
        )
        .join("; "),
    );
    this.name = "ShopifyUserError";
    this.userErrors = userErrors;
  }
}

import { shopifyConfig } from "./shopify.config";
import { REQUIRED_SUBSCRIPTIONS } from "./shopify.constants";
import { toE164US, mapAddress, toOrderGid } from "./shopify.utils";
import {
  QUERY_WEBHOOK_SUBSCRIPTIONS_BY_TOPIC,
  QUERY_ALL_WEBHOOK_SUBSCRIPTIONS,
  QUERY_CUSTOMER_TAGS,
  QUERY_FILE_BY_ID,
} from "./shopify.queries";
import {
  MUTATION_ORDER_MARK_AS_PAID,
  MUTATION_WEBHOOK_SUBSCRIPTION_CREATE,
  MUTATION_CUSTOMER_CREATE,
  MUTATION_CUSTOMER_SEND_INVITE,
  MUTATION_CUSTOMER_UPDATE,
  MUTATION_CUSTOMER_DELETE,
  MUTATION_ORDER_DELETE,
  MUTATION_STAGED_UPLOADS_CREATE,
  MUTATION_FILE_CREATE,
} from './shopify.mutations'
import {
  getUnauthenticatedAdmin,
  executeGraphQL,
  executeMutation,
  shopifyRestPost,
} from './shopify.apis'
import { createLogger } from '../../utils/logger.utils'
import { PermanentError, TransientError } from '../../utils/retry.utils'

const log = createLogger("shopify.service");

// ── Orders ───────────────────────────────────────────────────────────

// Marks a Shopify order as paid. Returns the order's new
// displayFinancialStatus on success ("PAID"). Idempotent — Shopify
// returns a userError ("This order has already been paid") on the
// second call which we treat as success.
export async function markShopifyOrderPaid({ shop, shopifyOrderId }) {
  if (!shop || !shopifyOrderId) {
    throw new Error(
      "markShopifyOrderPaid: shop and shopifyOrderId are required",
    );
  }

  console.log(
    `[shopify] markShopifyOrderPaid shop=${shop} order=${shopifyOrderId}`,
  );
  log.info("mark_paid.request", { shop, shopifyOrderId });

  const { admin } = await getUnauthenticatedAdmin(shop);
  const gid = toOrderGid(shopifyOrderId);

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_ORDER_MARK_AS_PAID,
    { input: { id: gid } },
    "orderMarkAsPaid",
  );

  // Idempotency: if Shopify says "already paid" — by any phrasing —
  // treat as success. Shopify has at least three ways to report this:
  //   - "Order is already paid"     (literal already-paid)
  //   - "Order already captured"    (auth+capture flow)
  //   - "fully paid"                (alternative phrasing on some versions)
  //   - "Order cannot be marked as paid"
  //       ← surfaces when our SALE transactions on the order already
  //         sum to the order total (Shopify auto-computes
  //         displayFinancialStatus=PAID from the txn ledger, so
  //         orderMarkAsPaid rejects as redundant). Common when
  //         recordOrderTransaction was called per-partial just before.
  const alreadyPaid = userErrors.some((e) =>
    /already.*paid|already.*captured|fully paid|cannot.*be.*marked.*as.*paid/i.test(
      e.message || '',
    ),
  )
  if (alreadyPaid) {
    console.log(
      `[shopify] order ${shopifyOrderId} was already paid — treating as success`,
    );
    log.info("mark_paid.already_paid", { shop, shopifyOrderId });
    return { financialStatus: "PAID", alreadyPaid: true };
  }

  if (userErrors.length) {
    const msg = userErrors.map((e) => e.message).join("; ");
    console.error(`[shopify] orderMarkAsPaid userErrors: ${msg}`);
    log.error("mark_paid.user_error", { shop, shopifyOrderId, userErrors });
    throw new PermanentError(`Shopify orderMarkAsPaid userErrors: ${msg}`, {
      body: userErrors,
    });
  }

  const order = data?.order;
  console.log(
    `[shopify] order ${shopifyOrderId} marked PAID — displayFinancialStatus=${order?.displayFinancialStatus}`,
  );
  log.info("mark_paid.success", {
    shop,
    shopifyOrderId,
    financialStatus: order?.displayFinancialStatus,
  });
  return {
    financialStatus: order?.displayFinancialStatus,
    updatedAt: order?.updatedAt,
    alreadyPaid: false,
  }
}

// Record a manual SALE transaction against a Shopify order. Used for
// partial-payment mirroring: each cheque receipt / NMI partial charge
// pushes one SALE transaction so Shopify computes the right
// `displayFinancialStatus` (paid / partially_paid) from the sum of
// transactions on the order. Full settlement still calls
// `markShopifyOrderPaid` separately — Shopify treats that as
// idempotent ("already paid") when transactions already cover the
// total.
//
// Why REST: the Admin GraphQL API only exposes `orderCapture` for
// transactions, which requires a pre-existing AUTHORIZATION the
// wholesale storefront orders never carry. The REST
// `orders/{id}/transactions.json` endpoint accepts a `kind: 'sale'`
// with a `gateway: 'manual'` for external-payment recording.
//
// Returns { shopifyTransactionId, kind, amount }. Throws
// PermanentError on userErrors that mean the call can't ever succeed
// (e.g. order not found); transient network errors propagate through
// shopifyRestPost's classifier so the retry layer can back off.
export async function recordOrderTransaction({
  shop,
  shopifyOrderId,
  amount,
  currency,
  paymentRef,
  gateway,
}) {
  if (!shop || !shopifyOrderId) {
    throw new Error('recordOrderTransaction: shop and shopifyOrderId are required')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `recordOrderTransaction: amount must be > 0, got ${amount}`,
    )
  }

  console.log(
    `[shopify] recordOrderTransaction shop=${shop} order=${shopifyOrderId} amount=$${Number(amount).toFixed(2)}`,
  )
  log.info('transaction.request', {
    shop,
    shopifyOrderId,
    amount,
    paymentRef: paymentRef || null,
  })

  const { session } = await getUnauthenticatedAdmin(shop)
  const json = await shopifyRestPost({
    shop,
    session,
    path: `/orders/${encodeURIComponent(shopifyOrderId)}/transactions.json`,
    body: {
      transaction: {
        kind: 'sale',
        amount: Number(amount).toFixed(2),
        currency: currency || 'USD',
        status: 'success',
        gateway: gateway || 'manual',
        source: 'external',
        // 50-char limit on Shopify's side per docs — slice defensively.
        ...(paymentRef ? { authorization: String(paymentRef).slice(0, 50) } : {}),
      },
    },
  })
  const txn = json?.transaction
  if (!txn?.id) {
    throw new PermanentError(
      `Shopify orders/${shopifyOrderId}/transactions returned no id`,
      { body: json },
    )
  }
  console.log(
    `[shopify] transaction recorded id=${txn.id} kind=${txn.kind} amount=${txn.amount} status=${txn.status}`,
  )
  log.info('transaction.success', {
    shop,
    shopifyOrderId,
    shopifyTransactionId: String(txn.id),
    amount: txn.amount,
    status: txn.status,
  })
  return {
    shopifyTransactionId: String(txn.id),
    kind: txn.kind,
    amount: txn.amount,
    status: txn.status,
  }
}

// ── Webhook subscriptions ────────────────────────────────────────────

function callbackUrl(callbackPath) {
  const base = shopifyConfig.appUrl;
  if (!base)
    throw new Error(
      "SHOPIFY_APP_URL not set; cannot build webhook callback URL",
    );
  return `${base.replace(/\/$/, "")}${callbackPath}`;
}

async function existingSubscriptions(admin, topic) {
  const json = await executeGraphQL(
    admin,
    QUERY_WEBHOOK_SUBSCRIPTIONS_BY_TOPIC,
    { topics: [topic] },
  );
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || [];
}

async function createSubscription(admin, { topic, callbackPath }) {
  const url = callbackUrl(callbackPath);
  const { userErrors, data } = await executeMutation(
    admin,
    MUTATION_WEBHOOK_SUBSCRIPTION_CREATE,
    { topic, sub: { callbackUrl: url, format: "JSON" } },
    "webhookSubscriptionCreate",
  );
  if (userErrors.length) {
    // Most likely cause in dev: "not approved for protected customer data".
    throw new Error(
      `webhookSubscriptionCreate(${topic}): ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  return data?.webhookSubscription?.id;
}

// In-memory guard so a busy admin session doesn't spam the existence
// check on every loader. Keyed by shop domain.
const registered = new Set();

// Idempotently ensure every required subscription is registered. Safe to
// call on every authenticated admin request — most invocations are
// in-memory no-ops once registration has succeeded once per process.
//
// Failures are logged but never thrown to the caller, so a missing
// Partners approval doesn't break the embedded admin UI.
export async function ensureProtectedWebhooks({ admin, shop }) {
  if (!shop || !admin) return;
  if (registered.has(shop)) return;

  console.log(`\n========== Webhook registration check: ${shop} ==========`);
  for (const sub of REQUIRED_SUBSCRIPTIONS) {
    try {
      const desiredUrl = callbackUrl(sub.callbackPath);
      const existing = await existingSubscriptions(admin, sub.topic);
      const match = existing.find(
        (s) => s.endpoint?.callbackUrl === desiredUrl,
      );
      if (match) {
        console.log(
          `  [OK]      ${sub.topic} already subscribed → ${desiredUrl}`,
        );
        log.info("subscription.present", {
          shop,
          topic: sub.topic,
          url: desiredUrl,
        });
        continue;
      }
      const id = await createSubscription(admin, sub);
      console.log(`  [CREATED] ${sub.topic} → ${desiredUrl}  (id=${id})`);
      log.info("subscription.created", {
        shop,
        topic: sub.topic,
        id,
        url: desiredUrl,
      });
    } catch (err) {
      console.log(`  [FAILED]  ${sub.topic}: ${err.message}`);
      console.log(
        "            → This usually means the app is not approved for",
      );
      console.log(
        "              protected customer data. Approve in Partners dashboard:",
      );
      console.log(
        "              Partners → your app → API access → Protected customer data",
      );
      log.warn("subscription.skipped", {
        shop,
        topic: sub.topic,
        reason: err.message,
      });
    }
  }
  console.log("=========================================================\n");

  registered.add(shop);
}

// List every webhook subscription registered for this shop (regardless
// of topic). Used by the /app/webhooks diagnostic page.
export async function listAllWebhookSubscriptions(admin) {
  const json = await executeGraphQL(admin, QUERY_ALL_WEBHOOK_SUBSCRIPTIONS);
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || [];
}

// ── Customers ────────────────────────────────────────────────────────

// Create a customer with marketing consent + initial tags + the wholesale
// note. Used by the registration-form submission flow.
export async function createCustomer(
  admin,
  { application, note, tags = ["Pending"], subscribeNews = false },
) {
  const addresses = [];
  if (application.billingAddress) {
    addresses.push({
      ...mapAddress(application.billingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
    });
  }
  if (!application.shippingSameAsBilling && application.shippingAddress) {
    addresses.push({
      ...mapAddress(application.shippingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
    });
  }

  // Phone goes on the customer top-level — that's the field Shopify enforces
  // uniqueness on. Sending it inside addresses[].phone caused inconsistent
  // collisions (Shopify auto-promotes address phone to top-level under some
  // conditions). Top-level is deterministic: either accepts or returns a
  // clean userError that the caller surfaces as a fieldError.
  const input = {
    email: application.email,
    firstName: application.firstName,
    lastName: application.lastName,
    phone: toE164US(application.phone),
    tags,
    note,
    addresses,
    emailMarketingConsent: {
      marketingState: subscribeNews ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
      marketingOptInLevel: subscribeNews ? "SINGLE_OPT_IN" : null,
      // Back-date 60s so clock skew with Shopify can't trigger "must not be in the future".
      consentUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  };

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_CREATE,
    { input },
    "customerCreate",
  );
  if (userErrors.length) throw new ShopifyUserError(userErrors);
  const id = data?.customer?.id;
  if (!id) throw new Error("customerCreate returned no customer");
  return id;
}

export async function sendCustomerInvite(
  admin,
  { customerId, subject, message, fromEmail },
) {
  const emailInput = {};
  if (subject) emailInput.subject = subject;
  if (message) emailInput.customMessage = message;
  if (fromEmail) emailInput.from = fromEmail;

  const { userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_SEND_INVITE,
    {
      customerId,
      email: Object.keys(emailInput).length ? emailInput : null,
    },
    "customerSendAccountInviteEmail",
  );
  if (userErrors.length)
    throw new Error(userErrors.map((e) => e.message).join("; "));
  return true;
}

// Fetch the current tags for a Shopify customer using an offline session
// (no request context required — callable from webhook handlers and the
// scheduler). Returns [] if the customer can't be found.
//
// Webhook payloads do include `customer.tags`, but that's a snapshot at
// order creation. For approval gating we want the LIVE state — so a
// customer who was tagged "Approved" between order creation and webhook
// arrival is processed correctly.
export async function getCustomerTags({ shop, customerId }) {
  if (!shop || !customerId) {
    throw new Error("getCustomerTags: shop and customerId are required");
  }
  const gid = String(customerId).startsWith("gid://")
    ? String(customerId)
    : `gid://shopify/Customer/${customerId}`;

  const { admin } = await getUnauthenticatedAdmin(shop);
  const json = await executeGraphQL(admin, QUERY_CUSTOMER_TAGS, { id: gid });
  const tags = json?.data?.customer?.tags;
  if (!Array.isArray(tags)) return [];
  return tags;
}

// Convenience predicate used by the order orchestrator's approval gate.
// Case-insensitive match against the literal "Approved" tag we set when
// an admin approves a wholesale application (see admin/review.js).
export async function customerHasApprovedTag({ shop, customerId }) {
  if (!shop || !customerId) return false;
  const tags = await getCustomerTags({ shop, customerId });
  return tags.some((t) => String(t).trim().toLowerCase() === "approved");
}

// Swap one tag for another on a Shopify customer. Reads current tags,
// removes `removeTag`, adds `addTag`, writes back.
export async function updateCustomerTags(
  admin,
  { customerId, addTag, removeTag },
) {
  const readJson = await executeGraphQL(admin, QUERY_CUSTOMER_TAGS, {
    id: customerId,
  });
  const current = readJson?.data?.customer?.tags || [];
  const next = Array.from(
    new Set([...current.filter((t) => t !== removeTag), addTag]),
  );

  const { data, userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_UPDATE,
    { input: { id: customerId, tags: next } },
    "customerUpdate",
  );
  if (userErrors.length)
    throw new Error(userErrors.map((e) => e.message).join("; "));
  return data?.customer?.tags || next;
}

export async function deleteCustomer(admin, customerId) {
  const { userErrors } = await executeMutation(
    admin,
    MUTATION_CUSTOMER_DELETE,
    { id: customerId },
    "customerDelete",
  );
  if (userErrors.length)
    throw new Error(userErrors.map((e) => e.message).join("; "));
  return true;
}

export async function deleteOrder(admin, shopifyOrderId) {
  const orderGid = toOrderGid(shopifyOrderId);
  const { userErrors } = await executeMutation(
    admin,
    MUTATION_ORDER_DELETE,
    { orderId: orderGid },
    "orderDelete",
  );
  if (userErrors.length)
    throw new Error(userErrors.map((e) => e.message).join("; "));
  return true;
}

// ── File uploads ─────────────────────────────────────────────────────

// Multi-step Shopify Files API upload. Returns the permanent CDN URL once
// the file is READY. Used by the registration-form proxy for license
// uploads, signature PNGs, etc.
//
// Three round-trips: staged upload target → bytes upload → fileCreate.
// If fileCreate returns a URL synchronously we skip the polling step.
export async function uploadFileToShopify(admin, file) {
  const isImage = (file.type || "").startsWith("image/");
  const resourceKind = isImage ? "IMAGE" : "FILE";

  // 1. Get a staged upload target
  const stagedJson = await executeGraphQL(
    admin,
    MUTATION_STAGED_UPLOADS_CREATE,
    {
      input: [
        {
          filename: file.name || "upload",
          mimeType: file.type || "application/octet-stream",
          fileSize: String(file.size),
          httpMethod: "POST",
          resource: resourceKind,
        },
      ],
    },
  );
  const stagedErrors = stagedJson?.data?.stagedUploadsCreate?.userErrors;
  if (stagedErrors?.length) {
    throw new Error(
      `stagedUploadsCreate: ${stagedErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const target = stagedJson?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) throw new Error("No staged target returned");

  // 2. Upload the bytes to the staged target (Shopify-hosted S3-compatible bucket)
  const upload = new FormData();
  for (const p of target.parameters || []) upload.append(p.name, p.value);
  upload.append("file", file, file.name || "upload");

  const putRes = await fetch(target.url, { method: "POST", body: upload });
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => "");
    throw new Error(
      `Staged upload failed (${putRes.status}): ${txt.slice(0, 200)}`,
    );
  }

  // 3. Register the uploaded resource as a Shopify File
  const createdJson = await executeGraphQL(admin, MUTATION_FILE_CREATE, {
    files: [
      {
        originalSource: target.resourceUrl,
        contentType: resourceKind,
        alt: file.name || "upload",
      },
    ],
  });
  const createErrors = createdJson?.data?.fileCreate?.userErrors;
  if (createErrors?.length) {
    throw new Error(
      `fileCreate: ${createErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const created0 = createdJson?.data?.fileCreate?.files?.[0];
  if (!created0?.id) throw new Error("fileCreate returned no file");

  // If fileCreate already returned a URL (often the case for direct uploads),
  // skip the polling round-trip and use it.
  const immediateUrl = created0?.url || created0?.image?.url;
  if (immediateUrl) return immediateUrl;

  return pollFileUntilReady(admin, created0.id);
}

async function pollFileUntilReady(
  admin,
  fileId,
  { tries = 6, delayMs = 400 } = {},
) {
  for (let i = 0; i < tries; i++) {
    const json = await executeGraphQL(admin, QUERY_FILE_BY_ID, { id: fileId });
    const node = json?.data?.node;
    const status = node?.fileStatus;
    const url = node?.url || node?.image?.url;

    if (url) return url;
    if (status === "FAILED") throw new Error("File processing failed");

    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("File not READY after timeout");
}
