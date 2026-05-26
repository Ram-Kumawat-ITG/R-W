import crypto from "node:crypto";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { sendResponse } from "../services/APIService/api.service";
import { buildShopifyNote } from "../services/shopify/shopify.utils";
import {
  createCustomer,
  sendCustomerInvite,
  uploadFileToShopify,
  ShopifyUserError,
} from "../services/shopify/shopify.service";
import { createCustomerVault } from "../services/nmi/nmi.service"; 

// POST /api/registration-form
// Storefront-proxied wholesale application submit. Parses the multipart
// form, uploads attached files to Shopify Files, hashes the card / password,
// persists the application, then creates a Pending Shopify customer + sends
// the "received" acknowledgement email.
export async function action({ request }) {
  if (request.method !== "POST") {
    return sendResponse(405, "error", "Method not allowed", null);
  }

  let session, admin;
  try {
    const auth = await authenticate.public.appProxy(request);
    session = auth.session;
    admin = auth.admin;
  } catch (e) {
    console.error("[proxy/submit] appProxy auth failed:", e?.message || e);
    return sendResponse(401, "error", "Unauthorized", null);
  }

  if (!admin) {
    console.error("[proxy/submit] admin client unavailable from appProxy auth");
    return sendResponse(500, "error", "Admin client unavailable", null);
  }

  const shop =
    session?.shop || new URL(request.url).searchParams.get("shop") || null;

  await connectDB();

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    console.error("[proxy/submit] formData parse failed:", e?.message || e);
    return sendResponse(400, "error", "Invalid form payload", null);
  }

  // Build nested payload from bracketed keys; collect files separately
  const payload = {};
  const fileEntries = [];
  for (const [key, value] of formData.entries()) {
    if (
      typeof value === "object" &&
      value &&
      typeof value.arrayBuffer === "function"
    ) {
      if (value.size > 0) fileEntries.push({ key, file: value });
      setNested(payload, key, null);
    } else {
      setNested(payload, key, coerce(value));
    }
  }

  // Upload each file to Shopify Files → get a permanent CDN URL → put it in
  // payload. Files upload in parallel; sequential awaits would multiply
  // round-trips.
  try {
    const results = await Promise.all(
      fileEntries.map(async ({ key, file }) => {
        const url = await uploadFileToShopify(admin, file);
        return { key, url };
      }),
    );
    for (const { key, url } of results) {
      setNested(payload, key, url);
    }
  } catch (e) {
    console.error("[proxy/submit] upload failed:", e?.message || e);
    return sendResponse(502, "error", "File upload failed", {
      detail: e?.message || String(e),
    });
  }

  // Hash password before storage
  const plain = payload.password;
  delete payload.password;
  if (plain) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(plain, salt, 64).toString("hex");
    payload.passwordHash = `scrypt:${salt}:${derived}`;
  }

  // Normalise signature: prefer uploaded PNG file URL, fall back to typed text
  const signedAt = new Date();
  if (payload.signatureFile) {
    payload.signature = {
      type: "drawn",
      value: payload.signatureFile,
      signedAt,
    };
  } else if (payload.signatureType === "typed" && payload.signatureValue) {
    payload.signature = {
      type: "typed",
      value: payload.signatureValue,
      signedAt,
    };
  }
  delete payload.signatureFile;
  delete payload.signatureType;
  delete payload.signatureValue;

  payload.shop = shop;

  // Reject duplicate submissions before touching Shopify
  const existing = await WholesaleApplication.findOne({
    email: payload.email,
  }).lean();
  if (existing) {
    return sendResponse(
      409,
      "error",
      "An account with this email already exists.",
      {
        fieldErrors: [
          {
            field: "email",
            message: "An account with this email already exists.",
          },
        ],
      },
    );
  }

  // Soft-warn on duplicate phone — don't block submission, but flag the doc
  // so an admin can review. Shopify still enforces phone uniqueness at the
  // customer top-level and will return a clean userError if it collides.
  if (payload.phone) {
    const dupPhone = await WholesaleApplication.findOne({
      phone: payload.phone,
    }).lean();
    if (dupPhone) {
      console.warn(
        `[proxy/submit] duplicate phone detected — ${payload.phone} also on application ${dupPhone._id}`,
      );
      payload.phoneDuplicate = true;
    }
  }

  // Step 1 — NMI Customer Vault. CRITICAL. The vault id is required for
  // every future charge against this customer; without it the order pipeline
  // can't run. If creation fails we abort with no side effects: no Mongo
  // doc, no Shopify customer, no email. The applicant can retry from the
  // error screen.
  let nmiCustomerVaultId;
  try {
    nmiCustomerVaultId = await createCustomerVault({
      profile: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone,
        companyName: payload.businessName,
        billingAddress: payload.billingAddress,
      },
      paymentDetails: { paymentToken: payload.payment?.paymentToken },
    });
  } catch (vaultErr) {
    console.error(
      "[proxy/submit] NMI vault create failed:",
      vaultErr?.message || vaultErr,
    );
    return sendResponse(
      502,
      "error",
      "Could not save your payment method. Please try again.",
      {
        detail: vaultErr?.message || String(vaultErr),
      },
    );
  }
  if (!nmiCustomerVaultId) {
    console.error("[proxy/submit] NMI returned no vault id");
    return sendResponse(
      502,
      "error",
      "Could not save your payment method. Please try again.",
      null,
    );
  }

  // Restructure flat payment fields into nested card / ach shape before persisting.
  // Must run AFTER the NMI vault call which still needs the flat paymentToken.
  if (payload.payment) {
    const p = payload.payment
    payload.payment = {
      method: p.method,
      card: {
        cardholderName: p.cardholderName,
        cardBrand: p.cardBrand,
        cardLast4: p.cardLast4,
        paymentToken: p.paymentToken,
      },
      ach: p.method === 'ach' ? {
        achAccountName: p.achAccountName,
        achRoutingNumber: p.achRoutingNumber,
        achAccountLast4: p.achAccountLast4,
        achAccountType: p.achAccountType,
      } : null,
    }
  }

  // Step 2 — persist the wholesale application with the vault id baked in.
  // The most precious piece of data is now safely written to Mongo before
  // any further side effects.
  payload.nmiCustomerVaultId = nmiCustomerVaultId;

  let app;
  try {
    app = await WholesaleApplication.create(payload);
  } catch (e) {
    console.error("[proxy/submit] WholesaleApplication.create failed:", e);
    return sendResponse(500, "error", "Failed to save application", {
      detail: e.message,
    });
  }

  // Step 3 — Shopify customer + approval invite. Failure here is non-fatal:
  // the doc is flagged with shopifyCreateFailed so an admin can retry. The
  // applicant's NMI vault and application are already safely persisted.
  let customerId = null;
  try {
    if (!admin) throw new Error("admin client unavailable from appProxy auth");
    const note = buildShopifyNote(payload);
    customerId = await createCustomer(admin, {
      application: payload,
      note,
      tags: ["Approved"],
      subscribeNews: Boolean(payload.subscribeNews),
    });

    // Mark approved as soon as the Shopify customer exists with the
    // Approved tag. The invite email is a follow-up and its success/failure
    // must not gate the approval state — otherwise an SMTP hiccup leaves the
    // Mongo doc stuck at "pending" even though Shopify is fully approved.
    await WholesaleApplication.updateOne(
      { _id: app._id },
      {
        $set: {
          customerId,
          shopifyCreateFailed: false,
          shopifyCreateError: null,
          status: "approved",
          reviewedAt: new Date(),
        },
      },
    );

    try {
      await sendCustomerInvite(admin, {
        customerId,
        subject: "Your wholesale account has been approved",
        message:
          "Welcome to Natural Solutions Wholesale! Your application has been approved. Click the activation link below to set your password and start shopping at wholesale pricing.",
      });
      await WholesaleApplication.updateOne(
        { _id: app._id },
        { $set: { customerInviteSentAt: new Date() } },
      );
    } catch (inviteErr) {
      console.error(
        "[proxy/submit] received email failed:",
        inviteErr?.message || inviteErr,
      );
    }

    // Notify store admin of the new application
    try {
      const shopRes = await admin.graphql(`
        query {
          shop {
            email
            name
          }
        }
      `)
      const shopData = await shopRes.json()
      const storeEmail = shopData?.data?.shop?.email

      if (storeEmail) {
        const notifyRes = await admin.graphql(`
          mutation sendAdminNotification($input: EmailInput!) {
            emailSend(input: $input) {
              userErrors { field message }
            }
          }
        `, {
          variables: {
            input: {
              to: storeEmail,
              subject: `New Wholesale Application — ${payload.firstName} ${payload.lastName}`,
              body:
                `A new wholesale application has been submitted.\n\n` +
                `Name: ${payload.firstName} ${payload.lastName}\n` +
                `Email: ${payload.email}\n` +
                `Phone: ${payload.phone || 'N/A'}\n` +
                `Business: ${payload.businessName || 'N/A'}\n` +
                `Payment method: ${payload.payment?.method?.toUpperCase() || 'N/A'}\n\n` +
                `Review and approve in your admin dashboard.`,
            },
          },
        })
        const notifyData = await notifyRes.json()
        const notifyErrors = notifyData?.data?.emailSend?.userErrors
        if (notifyErrors?.length) {
          console.error('[proxy/submit] admin notification userErrors:', notifyErrors)
        } else {
          console.log(`[proxy/submit] admin notification sent to ${storeEmail}`)
        }
      }
    } catch (adminEmailErr) {
      console.error('[proxy/submit] admin notification email failed:', adminEmailErr?.message || adminEmailErr)
    }
  } catch (e) {
    console.error("[proxy/submit] customerCreate failed:", e?.message || e);

    // Shopify returned structured field errors (e.g., email/phone already taken).
    // Delete the doc we just created so the user can fix and resubmit cleanly.
    // Note: the NMI vault stays behind. On retry a fresh vault is created;
    // the orphan can be cleaned up offline if needed.
    if (e instanceof ShopifyUserError) {
      await WholesaleApplication.deleteOne({ _id: app._id });
      const fieldErrors = e.userErrors.map((ue) => {
        const rawField = Array.isArray(ue.field)
          ? ue.field[ue.field.length - 1]
          : ue.field;
        const field = rawField === "phone" ? "phone" : "email";
        return { field, message: ue.message };
      });
      return sendResponse(409, "error", e.userErrors[0].message, {
        fieldErrors,
      });
    }

    await WholesaleApplication.updateOne(
      { _id: app._id },
      {
        $set: {
          shopifyCreateFailed: true,
          shopifyCreateError: e?.message || String(e),
        },
      },
    );
  }

  return sendResponse(200, "success", "Application submitted", {
    id: app._id.toString(),
    customerId,
    nmiCustomerVaultId,
  });
}

export async function loader() {
  return sendResponse(405, "error", "Method not allowed", null);
}

// ── Form-parsing helpers (not Shopify-specific) ──────────────────────

function setNested(obj, path, value) {
  const keys = parsePath(path);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function parsePath(path) {
  const out = [];
  const re = /([^[\]]+)/g;
  let m;
  while ((m = re.exec(path)) !== null) out.push(m[1]);
  return out;
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  return v;
}
