// CDO QBO domain methods — the accounts-payable ("money out") side used
// by the commission payout engine: practitioner → Vendor, commission
// accrual → Bill, payout → BillPayment.
//
// Independent from the wholesale QBO integration (separate realm, config,
// and token store). All HTTP goes through the transport in qbo.apis.js.

import { qbo } from "./qbo.apis";
import { qboConfig, assertPostingAccountsConfigured } from "./qbo.config";
import connectDB from "../../db/mongo.server";
import CdoVendorMap from "../../models/cdoVendorMap.server";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("cdo.qbo.service");

// QBO QL escapes a single quote inside a string literal with a backslash.
function escapeQuery(value) {
  return String(value ?? "").replace(/'/g, "\\'");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ── Vendors ──────────────────────────────────────────────────────────

// QBO returns ACTIVE entities by default; inactive ones are returned only
// when you explicitly filter `Active = false`. There is no reliable single
// query for "both" (`Active IN (true,false)` does NOT include inactive),
// and the GET /vendor/{id} read endpoint 610s on an inactive vendor — so
// we always look up via query: active first, then inactive.
async function queryOneVendor(whereClause) {
  let res = await qbo.query(`SELECT * FROM Vendor WHERE ${whereClause}`);
  let v = res?.QueryResponse?.Vendor?.[0];
  if (v) return v;
  res = await qbo.query(`SELECT * FROM Vendor WHERE ${whereClause} AND Active = false`);
  return res?.QueryResponse?.Vendor?.[0] || null;
}

async function queryVendorByEmail(email) {
  if (!email) return null;
  // QBO QL can't filter Vendor by PrimaryEmailAddr (complex field →
  // "Invalid query"). Fetch vendors and match client-side; scan active
  // then inactive so a deactivated vendor is still found.
  const target = String(email).toLowerCase();
  const match = (list) =>
    list.find((v) => (v.PrimaryEmailAddr?.Address || "").toLowerCase() === target);
  let res = await qbo.query("SELECT * FROM Vendor MAXRESULTS 1000");
  let v = match(res?.QueryResponse?.Vendor || []);
  if (v) return v;
  res = await qbo.query("SELECT * FROM Vendor WHERE Active = false MAXRESULTS 1000");
  return match(res?.QueryResponse?.Vendor || []) || null;
}

async function queryVendorByDisplayName(displayName) {
  if (!displayName) return null;
  return queryOneVendor(`DisplayName = '${escapeQuery(displayName)}'`);
}

// Flip a deactivated vendor back to Active via a sparse update, so a Bill
// can be posted to it. Idempotent — re-running on an active vendor is a
// no-op write.
async function reactivateVendor(vendor) {
  const res = await qbo.update("/vendor", {
    Id: String(vendor.Id),
    SyncToken: vendor.SyncToken,
    Active: true,
    sparse: true,
  });
  return res?.Vendor || vendor;
}

// Find-or-create the QBO Vendor for a practitioner, caching the mapping in
// cdo_qbo_vendors so we create each vendor exactly once.
//
// IMPORTANT: QBO enforces name uniqueness across a SHARED name list that
// spans Customers + Vendors + Employees. A practitioner who also exists as
// a QBO Customer (common — they may be a wholesale customer too) would
// collide on a plain-name vendor create (6240), and the id QBO returns
// points at that Customer, not a Vendor — so it can't be adopted. We
// therefore create the vendor under a CDO-disambiguated, per-practitioner-
// unique DisplayName that can't clash with a customer/employee.
//
// Resolution order (QBO lookups are first-time only; the cache covers
// repeats):
//   1. cached mapping (cdo_qbo_vendors)
//   2. adopt an existing VENDOR by email / unique name / plain name (incl. inactive)
//   3. create under the unique name
export async function findOrCreateVendor({
  practitionerId,
  practitionerSource = "wholesale",
  displayName,
  email,
  firstName,
  lastName,
  companyName,
}) {
  await connectDB();

  // 1) Cached mapping.
  const cached = await CdoVendorMap.findOne({ practitionerId, practitionerSource }).lean();
  if (cached?.qboVendorId) return { qboVendorId: cached.qboVendorId, cached: true };

  const base = (displayName || "").trim() || email || "Practitioner";
  // Per-practitioner-unique vendor name, e.g. "Paker Collins (CDO 866674)".
  const uniqueName = `${base} (CDO ${String(practitionerId).slice(-6)})`;

  // 2) Adopt an existing vendor if one already matches — by email, our
  //    unique name, or the plain name (incl. inactive). Vendor-only:
  //    we never adopt a Customer/Employee from the shared name list.
  let vendor =
    (await queryVendorByEmail(email)) ||
    (await queryVendorByDisplayName(uniqueName)) ||
    (await queryVendorByDisplayName(base));

  // 3) Otherwise create under the unique name. A 6240 here means a VENDOR
  //    with the unique name already exists — adopt it (incl. inactive).
  if (!vendor) {
    const payload = {
      DisplayName: uniqueName,
      ...(companyName ? { CompanyName: companyName } : {}),
      ...(firstName ? { GivenName: firstName } : {}),
      ...(lastName ? { FamilyName: lastName } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    };
    try {
      const created = await qbo.post("/vendor", payload);
      vendor = created?.Vendor || null;
    } catch (err) {
      const code = err?.body?.Fault?.Error?.[0]?.code;
      if (code === "6240" || /duplicate/i.test(err?.message || "")) {
        vendor = await queryVendorByDisplayName(uniqueName);
      }
      if (!vendor) throw err;
    }
  }

  if (!vendor?.Id) {
    throw new Error(`CDO QBO: failed to resolve a vendor for practitioner ${practitionerId}`);
  }

  // A Bill can't be posted to an inactive vendor — reactivate if needed.
  if (vendor.Active === false) {
    vendor = await reactivateVendor(vendor);
  }

  // Persist the mapping (idempotent on the unique practitioner index).
  await CdoVendorMap.findOneAndUpdate(
    { practitionerId, practitionerSource },
    {
      $set: {
        qboVendorId: String(vendor.Id),
        displayName: vendor.DisplayName || uniqueName,
        email: email || vendor.PrimaryEmailAddr?.Address || undefined,
        syncedAt: new Date(),
      },
    },
    { upsert: true },
  );

  log.info("vendor.resolved", { practitionerId, qboVendorId: vendor.Id });
  return { qboVendorId: String(vendor.Id), cached: false };
}

// ── Bills (commission accrual) ───────────────────────────────────────

// Create a Bill against a vendor. `lines` is [{ amount, description }];
// each becomes an AccountBasedExpenseLine posted to the commission
// expense account. Returns the created Bill (Id, TotalAmt, ...).
export async function createBill({
  vendorId,
  lines,
  docNumber,
  privateNote,
  txnDate,
  dueDate,
  requestId,
}) {
  assertPostingAccountsConfigured();
  if (!vendorId) throw new Error("createBill: vendorId is required");
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("createBill: at least one line is required");
  }

  const Line = lines.map((l) => ({
    DetailType: "AccountBasedExpenseLineDetail",
    Amount: round2(l.amount),
    ...(l.description ? { Description: String(l.description).slice(0, 4000) } : {}),
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: qboConfig.commissionExpenseAccountId },
    },
  }));

  const payload = {
    VendorRef: { value: String(vendorId) },
    Line,
    ...(qboConfig.apAccountId ? { APAccountRef: { value: qboConfig.apAccountId } } : {}),
    ...(docNumber ? { DocNumber: String(docNumber).slice(0, 21) } : {}),
    ...(privateNote ? { PrivateNote: String(privateNote).slice(0, 4000) } : {}),
    ...(txnDate ? { TxnDate: toQboDate(txnDate) } : {}),
    ...(dueDate ? { DueDate: toQboDate(dueDate) } : {}),
  };

  const res = await qbo.post("/bill", payload, undefined, { requestId });
  const bill = res?.Bill;
  if (!bill?.Id) throw new Error("createBill: QBO did not return a Bill id");
  log.info("bill.created", { vendorId, billId: bill.Id, total: bill.TotalAmt });
  return bill;
}

export async function getBill(billId) {
  const res = await qbo.get(`/bill/${billId}`);
  return res?.Bill || null;
}

// ── Bill payments (payout settlement) ────────────────────────────────

// Record a BillPayment settling a single Bill, drawn from the configured
// bank/clearing account (PayType "Check" is QBO's representation of a bank
// account disbursement — this RECORDS the payment in the ledger; it does
// not itself initiate an ACH transfer). Returns the created BillPayment.
export async function createBillPayment({ vendorId, billId, amount, requestId }) {
  assertPostingAccountsConfigured();
  if (!vendorId) throw new Error("createBillPayment: vendorId is required");
  if (!billId) throw new Error("createBillPayment: billId is required");

  const total = round2(amount);
  const payload = {
    VendorRef: { value: String(vendorId) },
    TotalAmt: total,
    PayType: "Check",
    CheckPayment: { BankAccountRef: { value: qboConfig.paymentAccountId } },
    Line: [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: String(billId), TxnType: "Bill" }],
      },
    ],
  };

  const res = await qbo.post("/billpayment", payload, undefined, { requestId });
  const payment = res?.BillPayment;
  if (!payment?.Id) throw new Error("createBillPayment: QBO did not return a BillPayment id");
  log.info("billpayment.created", { vendorId, billId, billPaymentId: payment.Id, total });
  return payment;
}

// ── Helpers ──────────────────────────────────────────────────────────

// QBO date fields are date-only (YYYY-MM-DD).
function toQboDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

// Deep links for the admin UI so operators can open the record in QBO.
export function vendorWebUrl(vendorId) {
  return `${qboConfig.appBaseUrl}/app/vendordetail?nameId=${vendorId}`;
}
export function billWebUrl(billId) {
  return `${qboConfig.appBaseUrl}/app/bill?txnId=${billId}`;
}
