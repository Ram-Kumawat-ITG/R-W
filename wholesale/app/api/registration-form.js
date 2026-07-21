import crypto from "node:crypto";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { sendResponse } from "../services/APIService/api.service";
import { buildShopifyNote } from "../services/shopify/shopify.utils";
import {
  createCustomer,
  uploadFileToShopify,
  ShopifyUserError,
} from "../services/shopify/shopify.service";
import {
  createCustomerVault,
  deleteCustomerVault,
  addBillingToCustomerVault,
} from "../services/nmi/nmi.service";
import { generatePractitionerCode } from "../services/cdo/cdo.service";
import { encryptField } from "../utils/crypto.utils";
import {
  notifyApplicationSubmitted,
  notifyApplicationApproved,
  notifyApplicationDeclined,
} from "../services/notifications/applicationLifecycleNotification.service";
import { notifyNmiVaultCreationFailed } from "../services/notifications/nmiAlertNotification.service";

// Generate a stable, readable NMI billing_id. Random suffix prevents
// collisions when re-using a customer email; prefix makes logs scannable.
function generateBillingId(kind) {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${kind}_${rand}`;
}

// ── Helper: NMI vault compensating delete with retry ─────────────────
//
// Used when a step AFTER NMI-vault create (Mongo write, Shopify create)
// fails and we need to roll back. Retries up to 3× with linear backoff,
// then logs + returns false. Never throws — we don't want vault-cleanup
// failure to clobber the original error being returned to the user.
async function deleteNmiVaultWithRetry(vaultId, maxAttempts = 3) {
  if (!vaultId) return false;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deleteCustomerVault(vaultId);
      console.log(`[proxy/submit] NMI vault deleted on attempt ${attempt}: ${vaultId}`);
      return true;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[proxy/submit] NMI vault delete attempt ${attempt}/${maxAttempts} failed for ${vaultId}: ${err?.message || err}`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  console.error(
    `[proxy/submit] NMI vault delete exhausted ${maxAttempts} attempts for ${vaultId}; vault is now orphan — manual cleanup needed. Last error:`,
    lastErr?.message || lastErr,
  );
  return false;
}

// ── Helper: WholesaleApplication.create with retry ───────────────────
//
// Mongo writes are usually fast and reliable, but transient hiccups
// (network blip, replica-set election) can fail the first try. 3 attempts
// with linear backoff is more than enough — if all fail, the caller rolls
// back the NMI vault and surfaces an error.
async function createMongoDocWithRetry(payload, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await WholesaleApplication.create(payload);
    } catch (err) {
      lastErr = err;
      console.warn(
        `[proxy/submit] Mongo create attempt ${attempt}/${maxAttempts} failed: ${err?.message || err}`,
      );
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr;
}

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

  // W-9 signature — mirrors the Step 3 signature into the nested
  // w9.signature shape. The form collects ONE signature (on Step 3) that
  // covers both terms acceptance and the W-9 IRS Part II perjury
  // certification (per the "I authorize ..." block on Step 3, which now
  // explicitly includes a W-9 certification bullet). Duplicating into
  // w9.signature keeps the W-9 sub-doc self-contained for any future
  // W-9 PDF generation or audit-export pipeline without forcing those
  // tools to know about the top-level signature.
  if (payload.signature) {
    if (!payload.w9 || typeof payload.w9 !== "object") payload.w9 = {};
    payload.w9.signature = { ...payload.signature };
    payload.w9.submittedAt = signedAt;
  }

  // Strip empty-string values from W-9 sub-fields that have Mongoose
  // enums (`llcClassification` accepts only C/S/P/null). The frontend
  // emits `""` for these when the practitioner didn't pick LLC/Other —
  // Mongoose then rejects `""` because it isn't in the enum. Convert
  // empty → undefined so Mongoose treats the field as unset and falls
  // back to its default (null).
  if (payload.w9 && typeof payload.w9 === "object") {
    for (const key of [
      "llcClassification",
      "otherClassification",
      "exemptPayeeCode",
      "fatcaCode",
    ]) {
      if (payload.w9[key] === "") delete payload.w9[key];
    }
  }

  // Commission payout — required at signup. Two paths:
  //   • payoutMethod === 'ach'   → encrypt account number, save last4,
  //                                 wipe any check fields
  //   • payoutMethod === 'check' → save check.payableTo + mailing address
  //                                 (resolved against billingAddress if
  //                                 useBillingAddress = true), wipe any
  //                                 bank fields
  //
  // Server-side wipe of the non-selected branch prevents stale fields
  // from a previous client-side toggle leaking into the saved doc.
  if (payload.commission && typeof payload.commission === "object") {
    const c = payload.commission;
    const method = c.payoutMethod === "check" ? "check" : "ach";
    c.payoutMethod = method;
    c.enabled = true;
    c.updatedAt = new Date();

    if (method === "ach") {
      // Encrypt account number at rest. Last-4 is the only plaintext
      // representation that survives — used for admin display + audit.
      const rawAccount = String(c.bankAccountNumber || "").replace(/\D/g, "");
      if (rawAccount) {
        c.bankAccountLast4 = rawAccount.slice(-4);
        try {
          c.bankAccountEncrypted = encryptField(rawAccount);
        } catch (err) {
          console.error(
            "[registration-form] commission.encrypt_failed",
            err?.message || err,
          );
          return sendResponse(
            500,
            "error",
            "Could not securely save your commission bank account.",
            null,
          );
        }
        // Strip the legacy plaintext field so new rows never carry it.
        delete c.bankAccountNumber;
      }
      // Wipe the unused check branch.
      delete c.check;
    } else {
      // Check path — copy billing address into mailingAddress when the
      // practitioner opted to reuse it. Falls back to whatever was sent
      // when `useBillingAddress` is false. Billing (not shipping) is the
      // financial-mail address, matching where invoices + 1099s go.
      const chk = c.check && typeof c.check === "object" ? c.check : {};
      if (chk.useBillingAddress && payload.billingAddress) {
        chk.mailingAddress = { ...payload.billingAddress };
      }
      // Default `payableTo` to the applicant's name when blank — matches
      // the form's placeholder hint.
      if (!chk.payableTo || !String(chk.payableTo).trim()) {
        chk.payableTo = `${payload.firstName || ""} ${payload.lastName || ""}`.trim();
      }
      c.check = chk;
      // Wipe the unused ACH branch so the doc only carries the selected method's data.
      delete c.bankAccountName;
      delete c.bankRoutingNumber;
      delete c.bankAccountNumber;
      delete c.bankAccountEncrypted;
      delete c.bankAccountLast4;
      delete c.bankAccountType;
      delete c.sourcedFromPaymentAch;
    }
  }

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
  // can't run. Vault structure depends on the customer's preferred method:
  //
  //   method = 'card' or 'check' → 1 billing (card) — priority 1
  //   method = 'ach'             → 2 billings: ACH priority 1 + card priority 2
  //
  // For ACH customers, the card billing is a backup used by the admin
  // "Charge card on file" fallback. Card billing is always present because
  // a card on file is required for all wholesale accounts (per the Step 3
  // form copy and the project rule).
  //
  // We generate the billing_ids ourselves (vs letting NMI auto-assign) so
  // we can target either billing by ID when charging. If creation fails we
  // abort with no side effects: no Mongo doc, no Shopify customer, no email.
  const cardBillingId = generateBillingId("card");
  const achBillingId =
    payload.payment?.method === "ach" ? generateBillingId("ach") : null;

  const nmiProfile = {
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
    phone: payload.phone,
    companyName: payload.businessName,
    billingAddress: payload.billingAddress,
  };

  let nmiCustomerVaultId;
  try {
    if (payload.payment?.method === "ach") {
      // Step 1a — Create vault with ACH as the primary billing (priority 1).
      nmiCustomerVaultId = await createCustomerVault({
        profile: nmiProfile,
        paymentDetails: {
          achRouting: payload.payment.achRoutingNumber,
          achAccount: payload.payment.achAccountNumber, // full account — needed for NMI
          achAccountType: (payload.payment.achAccountType || "Checking").toLowerCase(),
          checkName: payload.payment.achAccountName,
        },
        billingId: achBillingId,
      });

      // Step 1b — Add card as secondary billing (priority 2) for backup
      // charges. If this fails after vault create, delete the vault to
      // avoid a half-configured vault (only ACH, no card backup).
      try {
        await addBillingToCustomerVault({
          customerVaultId: nmiCustomerVaultId,
          billingId: cardBillingId,
          profile: nmiProfile,
          paymentDetails: { paymentToken: payload.payment.paymentToken },
        });
      } catch (cardBillingErr) {
        console.error(
          "[proxy/submit] NMI add card billing failed for ACH customer:",
          cardBillingErr?.message || cardBillingErr,
        );
        await deleteNmiVaultWithRetry(nmiCustomerVaultId);
        await notifyNmiVaultCreationFailed({
          email: payload.email,
          businessName: payload.businessName,
          paymentMethod: payload.payment?.method,
          stage: "ACH customer — secondary card billing add",
          error: cardBillingErr,
        }).catch((e) => console.error("[proxy/submit] NMI alert failed:", e?.message || e));
        await notifyApplicationDeclined({
          email: payload.email,
          firstName: payload.firstName,
          lastName: payload.lastName,
          businessName: payload.businessName,
          reason: "We could not verify the card details provided as your backup payment method.",
        }).catch((e) => console.error("[proxy/submit] decline email failed:", e?.message || e));
        return sendResponse(
          502,
          "error",
          "Could not save your card on file. Please try again.",
          { detail: cardBillingErr?.message || String(cardBillingErr) },
        );
      }
    } else {
      // 'card' or 'check' — single card billing as priority 1.
      nmiCustomerVaultId = await createCustomerVault({
        profile: nmiProfile,
        paymentDetails: { paymentToken: payload.payment?.paymentToken },
        billingId: cardBillingId,
      });
    }
  } catch (vaultErr) {
    console.error(
      "[proxy/submit] NMI vault create failed:",
      vaultErr?.message || vaultErr,
    );
    await notifyNmiVaultCreationFailed({
      email: payload.email,
      businessName: payload.businessName,
      paymentMethod: payload.payment?.method,
      stage: "Primary vault creation",
      error: vaultErr,
    }).catch((e) => console.error("[proxy/submit] NMI alert failed:", e?.message || e));
    await notifyApplicationDeclined({
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      businessName: payload.businessName,
      reason:
        payload.payment?.method === "ach"
          ? "We could not verify the bank account details provided."
          : "We could not verify the card details provided.",
    }).catch((e) => console.error("[proxy/submit] decline email failed:", e?.message || e));
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
    await notifyNmiVaultCreationFailed({
      email: payload.email,
      businessName: payload.businessName,
      paymentMethod: payload.payment?.method,
      stage: "Vault creation resolved with no vault id",
      error: new Error("createCustomerVault resolved successfully but returned no vault id"),
    }).catch((e) => console.error("[proxy/submit] NMI alert failed:", e?.message || e));
    await notifyApplicationDeclined({
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      businessName: payload.businessName,
      reason: "We could not verify the payment details provided.",
    }).catch((e) => console.error("[proxy/submit] decline email failed:", e?.message || e));
    return sendResponse(
      502,
      "error",
      "Could not save your payment method. Please try again.",
      null,
    );
  }

  // Restructure flat payment fields into nested card / ach shape before
  // persisting. The card billing_id is ALWAYS stored (every customer has
  // a card on file). The ach billing_id is stored ONLY for ACH-preferred
  // customers. Full ACH account number is NEVER stored in Mongo — only
  // the last 4 digits, plus the NMI billing_id which is our handle to
  // charge ACH via NMI's vault.
  if (payload.payment) {
    const p = payload.payment;
    payload.payment = {
      method: p.method,
      card: {
        cardholderName: p.cardholderName,
        cardBrand: p.cardBrand,
        cardLast4: p.cardLast4,
        paymentToken: p.paymentToken,
        nmi_billing_id: cardBillingId,
      },
      ach:
        p.method === "ach"
          ? {
              achAccountName: p.achAccountName,
              achRoutingNumber: p.achRoutingNumber,
              achAccountLast4: p.achAccountLast4,
              achAccountType: p.achAccountType,
              nmi_billing_id: achBillingId,
            }
          : null,
    };
  }

  // Step 2 — persist the wholesale application with the vault id baked in.
  // The most precious piece of data is now safely written to Mongo before
  // any further side effects. Retries 3× on transient failures; if all
  // retries fail, the NMI vault is rolled back so the customer can retry
  // from a clean state.
  payload.nmiCustomerVaultId = nmiCustomerVaultId;

  let app;
  try {
    app = await createMongoDocWithRetry(payload);
  } catch (e) {
    console.error("[proxy/submit] WholesaleApplication.create failed after retries:", e);
    // Roll back the NMI vault — without this, a customer resubmitting would
    // accumulate a fresh vault each attempt while the failed one orphans.
    await deleteNmiVaultWithRetry(nmiCustomerVaultId);
    return sendResponse(500, "error", "Failed to save application", {
      detail: e.message,
    });
  }

  // Application is persisted (NMI succeeded) — confirm receipt. Best-effort and
  // FIRE-AND-FORGET: this must NEVER sit in the critical path between the Mongo
  // write and the Shopify customer create. A slow/hung SMTP send here would
  // block the request long enough to trip the Shopify App Proxy gateway
  // timeout, leaving the reported inconsistent state (Mongo doc created, no
  // Shopify customer). The email still sends in the background.
  notifyApplicationSubmitted({
    email: payload.email,
    firstName: payload.firstName,
    lastName: payload.lastName,
    businessName: payload.businessName,
  }).catch((e) => console.error("[proxy/submit] submitted email failed:", e?.message || e));

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
      tags: ["Approved", "practitioner"],
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

    // Best-effort + FIRE-AND-FORGET — never blocks the response (or the CDO
    // step below) on an SMTP hiccup. The Mongo doc is already marked approved.
    notifyApplicationApproved({
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      businessName: payload.businessName,
    }).catch((e) => console.error("[proxy/submit] approved email failed:", e?.message || e));

    // CDO Phase 1 — auto-generate a practitioner referral code for this
    // newly-approved practitioner. Failure here is log-only by design:
    // the customer + NMI vault + application are already persisted, and
    // an admin can re-generate manually from the ns-retail CDO admin if
    // this throws. We do NOT want a transient DB blip in the CDO
    // collection to fail an otherwise-successful registration.
    // FIRE-AND-FORGET: generatePractitionerCode makes a cross-store retail
    // Shopify Admin call (creates the referral discount) that can be slow —
    // keep it off the response path so it can't push the request toward the
    // gateway timeout. It's idempotent + already non-fatal, and an admin can
    // regenerate from the ns-retail CDO admin if it fails.
    generatePractitionerCode({
      applicationId: app._id,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      shop: payload.shop,
    })
      .then((cdoResult) =>
        console.log(
          `[proxy/submit] CDO code ${cdoResult.code} ${cdoResult.alreadyExisted ? "reused (idempotent)" : "generated"} for application=${app._id}`,
        ),
      )
      .catch((cdoErr) =>
        console.error(
          "[proxy/submit] CDO code generation failed (non-fatal):",
          cdoErr?.message || cdoErr,
        ),
      );

    // NOTE: We intentionally do NOT send the Shopify account-invite email
    // that includes an account-activation / password-set link. The system
    // uses an email OTP login flow: customers sign in by entering their
    // email and receiving a one-time code. Sending a password-setup invite
    // (Shopify's account activation) is therefore misleading and has been
    // removed. If you need to re-enable invites for a specific shop, call
    // `sendCustomerInvite` explicitly or add a config-gated path here.

    // (Admin email notification removed — was using a non-existent
    // `emailSend` mutation. Shopify Admin GraphQL has no generic send-email
    // mutation. Admins see new applications on the Customers admin page.
    // If real-time notification becomes important, wire up Resend or
    // nodemailer — see CLAUDE.md changelog for context.)
  } catch (e) {
    console.error("[proxy/submit] customerCreate failed:", e?.message || e);

    // Shopify returned structured field errors (e.g., email/phone already
    // taken, invalid format). ALWAYS full rollback: delete both the NMI
    // vault and the Mongo doc so the customer can resubmit cleanly without
    // any stale records. Earlier we had a "duplicate phone" exception that
    // kept both — reversed on the project owner's request: if Shopify
    // refused to create the customer, we don't want a Mongo doc OR an
    // NMI vault hanging around either.
    if (e instanceof ShopifyUserError) {
      await deleteNmiVaultWithRetry(nmiCustomerVaultId);
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
