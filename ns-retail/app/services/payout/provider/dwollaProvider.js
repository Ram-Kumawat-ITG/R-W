/* eslint-env node */
// Dwolla ACH disbursement adapter.
//
// Implements the PayoutProvider contract (see provider/index.js) over Dwolla's
// REST API (raw fetch — no SDK dependency). Money flows:
//
//   business funding source (DWOLLA_FUNDING_SOURCE)  ──ACH credit──▶
//     practitioner's receive-only Customer → their bank funding source
//
// initiateTransfer, per payout:
//   1. find-or-create a receive-only Customer for the practitioner (by email)
//   2. find-or-create their bank Funding Source (routing/account/type)
//   3. create a Transfer (source → destination) with an Idempotency-Key
//   → returns { transferId, status: "pending" }
//
// getTransferStatus polls the transfer; Dwolla "processed" → settled,
// "failed"/"cancelled" → returned (with the ACH R-code from /transfers/{id}/failure).
//
// Dwolla customer/funding-source creation is naturally idempotent: a duplicate
// POST returns 400 with the existing resource's URL in
// `_embedded.errors[0]._links.about.href`, which we adopt.

import { payoutConfig } from "../payout.config";
import { createLogger } from "../../../utils/logger.utils";

const log = createLogger("payout.dwolla");

const BASE_URLS = {
  sandbox: "https://api-sandbox.dwolla.com",
  production: "https://api.dwolla.com",
};
const HAL_JSON = "application/vnd.dwolla.v1.hal+json";

function cfg() {
  const c = payoutConfig.dwolla || {};
  const base = BASE_URLS[c.environment] || BASE_URLS.sandbox;
  return { ...c, base };
}

// Resource id from a Dwolla resource URL (or pass-through if already an id).
function idFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  return s.includes("/") ? s.split("/").filter(Boolean).pop() : s;
}

// Full source funding-source URL from the configured value (URL or bare id).
function sourceFundingHref(base, fundingSource) {
  if (!fundingSource) return null;
  return String(fundingSource).startsWith("http")
    ? String(fundingSource)
    : `${base}/funding-sources/${fundingSource}`;
}

// ── OAuth2 client_credentials token (cached + refreshed near expiry) ──
let _token = null; // { value, expiresAt }

async function getToken() {
  const c = cfg();
  if (!c.key || !c.secret) {
    throw new Error("Dwolla not configured — set DWOLLA_KEY and DWOLLA_SECRET");
  }
  // Reuse while > 60s of life remains.
  if (_token && _token.expiresAt - Date.now() > 60_000) return _token.value;

  const basic = Buffer.from(`${c.key}:${c.secret}`).toString("base64");
  const res = await fetch(`${c.base}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Dwolla token request failed (${res.status}): ${body.error_description || body.error || "no access_token"}`,
    );
  }
  _token = {
    value: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  return _token.value;
}

// Low-level request. Returns { res, body, location }. Never throws on non-2xx
// (callers inspect status) — only throws on network/parse failure.
async function request(method, path, { body, idempotencyKey } = {}) {
  const c = cfg();
  const token = await getToken();
  const url = path.startsWith("http") ? path : `${c.base}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: HAL_JSON,
  };
  if (body) headers["Content-Type"] = HAL_JSON;
  if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey);

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text || null;
  }
  return { res, body: parsed, location: res.headers.get("location") };
}

// Pull the existing resource URL out of a Dwolla duplicate-resource error.
function duplicateHref(errBody) {
  const errs = errBody?._embedded?.errors;
  if (Array.isArray(errs)) {
    for (const e of errs) {
      const href = e?._links?.about?.href;
      if (href) return href;
    }
  }
  return errBody?._links?.about?.href || null;
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "Practitioner", lastName: "Payee" };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// find-or-create a receive-only Customer for the practitioner → customer URL.
async function ensureCustomer({ email, name, businessName }) {
  if (!email) throw new Error("Dwolla customer requires an email (practitionerEmail)");
  const { firstName, lastName } = splitName(name);
  const payload = {
    firstName: firstName.slice(0, 50),
    lastName: lastName.slice(0, 50),
    email: String(email).slice(0, 320),
    type: "receive-only",
    ...(businessName ? { businessName: String(businessName).slice(0, 255) } : {}),
  };
  const { res, body, location } = await request("POST", "/customers", { body: payload });
  if (res.status === 201 && location) return location;
  // Already exists → adopt the existing customer.
  const existing = duplicateHref(body);
  if (res.status === 400 && existing) return existing;
  throw new Error(
    `Dwolla createCustomer failed (${res.status}): ${JSON.stringify(body)?.slice(0, 400)}`,
  );
}

// find-or-create the practitioner's bank Funding Source → funding-source URL.
async function ensureFundingSource(customerUrl, { routingNumber, accountNumber, accountType, name }) {
  const payload = {
    routingNumber: String(routingNumber),
    accountNumber: String(accountNumber),
    bankAccountType: String(accountType || "checking").toLowerCase() === "savings" ? "savings" : "checking",
    name: String(name || "Practitioner bank").slice(0, 50),
  };
  const { res, body, location } = await request("POST", `${customerUrl}/funding-sources`, {
    body: payload,
  });
  if (res.status === 201 && location) return location;
  const existing = duplicateHref(body);
  if (res.status === 400 && existing) return existing;
  throw new Error(
    `Dwolla createFundingSource failed (${res.status}): ${JSON.stringify(body)?.slice(0, 400)}`,
  );
}

export const dwollaProvider = {
  name: "dwolla",

  async initiateTransfer({ amount, currency, destination, idempotencyKey, reference, metadata } = {}) {
    const c = cfg();
    const source = sourceFundingHref(c.base, c.fundingSource);
    if (!source) {
      throw new Error("Dwolla not configured — set DWOLLA_FUNDING_SOURCE (business source)");
    }

    const customerUrl = await ensureCustomer({
      email: metadata?.practitionerEmail,
      name: metadata?.practitionerName || destination?.accountName,
      businessName: metadata?.businessName,
    });
    const destFunding = await ensureFundingSource(customerUrl, destination || {});

    const transferBody = {
      _links: {
        source: { href: source },
        destination: { href: destFunding },
      },
      amount: {
        currency: (currency || "USD").toUpperCase(),
        value: Number(amount).toFixed(2),
      },
      metadata: {
        reference: String(reference || "").slice(0, 255),
        practitionerId: String(metadata?.practitionerId || ""),
      },
    };
    const { res, body, location } = await request("POST", "/transfers", {
      body: transferBody,
      idempotencyKey,
    });
    if (res.status === 201 && location) {
      log.info("transfer.created", { transferId: idFromUrl(location), reference });
      return { transferId: idFromUrl(location), status: "pending" };
    }
    // A clean validation rejection (bad bank, etc.) — surface as a failure so
    // the payout is marked failed with the reason.
    throw new Error(
      `Dwolla createTransfer failed (${res.status}): ${JSON.stringify(body)?.slice(0, 400)}`,
    );
  },

  // Advance provider-side pending transfers so settlement is fully automated
  // with NO manual dashboard step.
  //
  // PRODUCTION: real ACH settles through the banking network on its own — this
  // is a no-op (returns immediately, no API call).
  //
  // SANDBOX: Dwolla never clears transfers on its own — they stay `pending`
  // indefinitely until processed (normally the dashboard's "Process Bank
  // Transfers" button). The API equivalent is `POST /sandbox-simulations`
  // (body `{}`, → 202 `{ total }`), which processes/fails the last 500 pending
  // bank transfers on the account. A bank→bank transfer has TWO legs (debit +
  // credit), so it can take two simulation calls to fully clear — the per-tick
  // settlement CRON calls this each tick before polling, so transfers converge
  // pending → processed → settled automatically. No Dwolla dashboard interaction.
  async processPendingTransfers() {
    const c = cfg();
    if (c.environment !== "sandbox") return { advanced: false, skipped: true };
    // Each call processes one clearing pass; a bank→bank transfer's debit +
    // credit legs clear on successive passes. Loop until nothing remains
    // pending (capped) so everything settles within ONE settlement tick.
    let processed = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      const { res, body } = await request("POST", "/sandbox-simulations", { body: {} });
      if (!res.ok) {
        throw new Error(
          `Dwolla sandbox-simulations failed (${res.status}): ${JSON.stringify(body)?.slice(0, 300)}`,
        );
      }
      const total = body && typeof body.total === "number" ? body.total : 0;
      processed += total;
      if (total === 0) break;
    }
    if (processed) log.info("sandbox.transfers_processed", { processed });
    return { advanced: processed > 0, total: processed };
  },

  async getTransferStatus(transferId) {
    const id = idFromUrl(transferId);
    const { res, body } = await request("GET", `/transfers/${id}`);
    if (!res.ok) {
      throw new Error(`Dwolla getTransfer failed (${res.status}): ${JSON.stringify(body)?.slice(0, 300)}`);
    }
    const status = String(body?.status || "").toLowerCase();
    if (status === "processed") {
      return { status: "settled", settledAt: body?.created ? new Date(body.created) : new Date() };
    }
    if (status === "failed" || status === "cancelled" || status === "reclaimed") {
      // Fetch the ACH return code/reason when available.
      let returnCode = null;
      let returnReason = null;
      try {
        const f = await request("GET", `/transfers/${id}/failure`);
        if (f.res.ok && f.body) {
          returnCode = f.body.code || null;
          returnReason = f.body.description || f.body.explanation || null;
        }
      } catch {
        // best-effort — leave codes null
      }
      return {
        status: "returned",
        returnCode,
        returnReason: returnReason || `Dwolla transfer ${status}`,
      };
    }
    // pending / processingerror retryable → still in flight
    return { status: "pending" };
  },
};
