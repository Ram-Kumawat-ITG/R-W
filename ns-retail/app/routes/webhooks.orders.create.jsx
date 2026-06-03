import { authenticate, unauthenticated } from "../shopify.server";
import connectDB from "../db/mongo.server";
import CdoApplication from "../models/cdoApplication.server";
import CdoPractitionerCode from "../models/cdoPractitionerCode.server";

// In-memory dedup of webhook ids — Shopify delivers at-least-once and
// can fire the same payload multiple times in a short window. 5 min TTL
// is enough to absorb retries without leaking memory.
const _seenWebhookIds = new Set();
const SEEN_TTL_MS = 5 * 60 * 1000;

const CODE_PATTERN = /^[a-z]+_[a-f0-9]{8}$/i;

// Handler for retail Shopify orders/create.
//
// What it does on every paid order:
//   1. Verify HMAC
//   2. Dedup against the webhook id
//   3. Return 200 IMMEDIATELY (fire-and-forget the rest — never block
//      the webhook response on downstream Mongo / GraphQL calls)
//   4. Extract the practitioner code from cart attributes (preferred)
//      or from the order's discount_codes (fallback)
//   5. Look the code up in cdo_practitioner_codes (active only)
//   6. Tag the customer with `code:<the-code>`
//   7. Upsert cdo_applications by email — first-touch wins, only
//      populate referral if it's currently null
export async function action({ request }) {
  let topic, shop, payload, webhookId;
  try {
    const res = await authenticate.webhook(request);
    topic = res.topic;
    shop = res.shop;
    payload = res.payload;
    webhookId = request.headers.get("x-shopify-webhook-id");
  } catch (err) {
    console.error(
      "[webhooks.orders.create] HMAC auth failed:",
      err?.message || err,
    );
    return new Response(null, { status: 401 });
  }

  if (webhookId) {
    if (_seenWebhookIds.has(webhookId)) {
      console.log(`[webhooks.orders.create] duplicate webhook id ${webhookId}, skipping`);
      return new Response(null, { status: 200 });
    }
    _seenWebhookIds.add(webhookId);
    setTimeout(() => _seenWebhookIds.delete(webhookId), SEEN_TTL_MS).unref?.();
  }

  // Fire-and-forget so Shopify gets 200 fast. Errors inside the
  // promise are logged but don't affect the webhook response.
  processOrder({ shop, payload }).catch((err) => {
    console.error(
      `[webhooks.orders.create] processing order ${payload?.id} failed:`,
      err?.message || err,
    );
  });

  return new Response(null, { status: 200 });
}

async function processOrder({ shop, payload }) {
  const orderId = payload?.id;
  const code = extractPractitionerCode(payload);
  if (!code) {
    console.log(`[webhooks.orders.create] order ${orderId} — no practitioner code`);
    return;
  }

  await connectDB();
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeDoc = await CdoPractitionerCode.findOne({
    code: { $regex: `^${escaped}$`, $options: "i" },
    status: "active",
  }).lean();

  if (!codeDoc) {
    console.warn(
      `[webhooks.orders.create] order ${orderId} carried code "${code}" but it's not in cdo_practitioner_codes`,
    );
    return;
  }

  console.log(
    `[webhooks.orders.create] order ${orderId} matched code ${codeDoc.code} (practitioner=${codeDoc.practitionerEmail})`,
  );

  // 6. Tag the customer if we have one. Guest checkouts may not have a
  // linked customer; in that case skip tagging but still upsert the
  // cdo_application by email below.
  const customerGid = payload?.customer?.admin_graphql_api_id || null;
  if (customerGid) {
    await tagCustomerWithCode(shop, customerGid, codeDoc.code).catch((err) => {
      console.error(
        `[webhooks.orders.create] tag customer ${customerGid} failed:`,
        err?.message || err,
      );
    });
  }

  // 7. Upsert cdo_applications (first-touch wins for referral).
  const email = String(
    payload?.email || payload?.contact_email || payload?.customer?.email || "",
  )
    .toLowerCase()
    .trim();
  if (!email) {
    console.warn(`[webhooks.orders.create] order ${orderId} has no email — skipping cdo_application upsert`);
    return;
  }

  const referralSnapshot = buildReferralSnapshot(codeDoc);
  const existing = await CdoApplication.findOne({ email }).lean();

  if (existing) {
    // First-touch wins: don't overwrite existing referral. Just attach
    // the customerId if it was missing.
    const updates = {};
    if (!existing.referral) {
      updates.referral = referralSnapshot;
    }
    if (!existing.customerId && customerGid) {
      updates.customerId = customerGid;
    }
    if (Object.keys(updates).length) {
      await CdoApplication.updateOne({ _id: existing._id }, { $set: updates });
      console.log(
        `[webhooks.orders.create] updated cdo_application ${existing._id} — set ${Object.keys(updates).join(", ")}`,
      );
    } else {
      console.log(
        `[webhooks.orders.create] cdo_application ${existing._id} already complete — no update needed (first-touch wins)`,
      );
    }
    return;
  }

  // No row yet — create one. This happens when the order came from a
  // brand-new patient who didn't go through our signup form.
  await CdoApplication.create({
    shop,
    applicantType: "patient",
    firstName: payload?.customer?.first_name || payload?.billing_address?.first_name || null,
    lastName: payload?.customer?.last_name || payload?.billing_address?.last_name || null,
    email,
    billingAddress: null,
    shippingAddress: null,
    referral: referralSnapshot,
    status: "approved",
    submittedAt: new Date(),
    reviewedAt: null,
    customerId: customerGid,
  });
  console.log(
    `[webhooks.orders.create] created cdo_application for new patient ${email}`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractPractitionerCode(order) {
  // 1. Preferred: the cart attribute our checkout UI extension stamps
  //    on the order before discount apply. Reliable signal even if the
  //    discount itself was later removed by another code.
  const noteAttrs = order?.note_attributes || [];
  for (const attr of noteAttrs) {
    if (attr?.name === "cdo_practitioner_code" && attr?.value) {
      const v = String(attr.value).trim();
      if (v) return v;
    }
  }
  // 2. Fallback: scan discount_codes for one that matches the
  //    practitioner-code shape.
  const dcs = order?.discount_codes || [];
  for (const dc of dcs) {
    const c = String(dc?.code || "").trim();
    if (c && CODE_PATTERN.test(c)) return c;
  }
  return null;
}

async function tagCustomerWithCode(shop, customerGid, code) {
  const newTag = `code:${code}`;
  const { admin } = await unauthenticated.admin(shop);

  // Fetch existing tags so we don't clobber other tags
  const fetchRes = await admin.graphql(
    `query GetCustomerTags($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    { variables: { id: customerGid } },
  );
  const fetchData = await fetchRes.json();
  const existing = fetchData?.data?.customer?.tags || [];

  if (existing.includes(newTag)) {
    console.log(`[webhooks.orders.create] tag "${newTag}" already on ${customerGid}`);
    return;
  }

  const updRes = await admin.graphql(
    `mutation TagCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id tags }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: { id: customerGid, tags: [...existing, newTag] },
      },
    },
  );
  const updData = await updRes.json();
  const errs = updData?.data?.customerUpdate?.userErrors || [];
  if (errs.length) {
    throw new Error(
      `customerUpdate userErrors: ${errs.map((e) => e.message).join("; ")}`,
    );
  }
  console.log(`[webhooks.orders.create] tagged ${customerGid} with "${newTag}"`);
}

function buildReferralSnapshot(codeDoc) {
  return {
    code: codeDoc.code,
    codeId: String(codeDoc._id),
    practitionerId: codeDoc.practitionerId ? String(codeDoc.practitionerId) : null,
    practitionerSource: "wholesale",
    practitionerName: codeDoc.practitionerName || null,
    practitionerEmail: codeDoc.practitionerEmail || null,
    discountPercent:
      typeof codeDoc.discountPercent === "number" ? codeDoc.discountPercent : 0,
    commissionRate:
      typeof codeDoc.commissionRate === "number" ? codeDoc.commissionRate : null,
    linkedAt: new Date(),
  };
}

export async function loader() {
  return new Response("Method not allowed", { status: 405 });
}
