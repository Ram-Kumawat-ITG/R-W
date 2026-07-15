// PDFfiller → Wholesale Practitioner Registration migration import.
//
// Parses the Excel workbook described in
// docs/migration/pdffiller-practitioner-migration-plan.md +
// PDFfiller_Practitioner_Migration_Template.xlsx, validates it, and (when
// commit=true) recreates practitioner accounts through the SAME pipeline a
// live registration-form submit uses (app/api/registration-form.js): NMI
// Customer Vault → WholesaleApplication → Shopify customer + invite → CDO
// referral code.
//
// Hard constraint (see plan §6): a card payment method cannot be migrated
// from a spreadsheet — there is no way to produce a valid NMI payment token
// outside a live, PCI-scoped Collect.js session. ACH CAN be migrated
// directly (NMI accepts raw routing/account numbers server-side, same as
// the live form). Card/check-preferred practitioners import fully but with
// no NMI vault — flagged `needsCardCapture: true` — until they complete a
// one-time card re-capture step.
//
// Deliberate deviation from the live registration flow's rollback rule:
// registration-form.js fully rolls back (deletes the Mongo doc + NMI vault)
// on a Shopify customerCreate failure, because a live signup with no
// Shopify account is a clean failure the applicant can just retry. Here,
// migrated practitioners often already have a real Shopify customer record
// from ordering before this system existed, so a customerCreate failure
// (e.g. "email already taken") is expected, not fatal — the
// WholesaleApplication doc and NMI vault are kept, `shopifyCreateFailed` is
// set, and an admin resolves the Shopify side separately.

import * as XLSXModule from "xlsx";

const XLSX = XLSXModule.default || XLSXModule;
import connectDB from "../APIService/mongo.service";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import {
  createCustomer,
  sendCustomerInvite,
  uploadFileToShopify,
  findCustomerByEmail,
  updateCustomerTagsAndNote,
  ShopifyUserError,
} from "../shopify/shopify.service";
import { buildShopifyNote } from "../shopify/shopify.utils";
import { createCustomerVault, deleteCustomerVault } from "../nmi/nmi.service";
import { generatePractitionerCode } from "../cdo/cdo.service";
import { encryptField } from "../../utils/crypto.utils";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("practitionerMigration.service");

const SHEET_NAMES = {
  practitioners: "Practitioners",
  credentials: "Credentials",
  referralSources: "Referral_Sources",
  paymentSetup: "Payment_Setup",
  commissionPayout: "Commission_Payout",
  w9: "W9_Tax_Certification",
};

// ── Domain whitelists (mirrors registration-form/src/constants.js) ───────

const CREDENTIAL_SPECS = {
  acupuncturist: { textKeys: [], fileKey: "file0" },
  "bio-energetic": { textKeys: ["systemName", "systemSerial"], fileKey: null },
  chiropractor: { textKeys: [], fileKey: "file0" },
  "health-coach": { textKeys: [], fileKey: "file0" },
  medical: { textKeys: ["professionalCredentials"], fileKey: "file1" },
  massage: { textKeys: [], fileKey: "file0" },
  "naturopath-doctor": { textKeys: [], fileKey: "file0" },
  nutritionist: { textKeys: [], fileKey: "file0" },
  qest4: { textKeys: ["serialNumber", "systemType"], fileKey: null },
  reflexologist: { textKeys: [], fileKey: "file0" },
  "traditional-naturopath": { textKeys: [], fileKey: "file0" },
  veterinarian: { textKeys: [], fileKey: "file0" },
  other: { textKeys: ["description"], fileKey: "file0" },
};
const QEST4_SYSTEM_TYPES = ["Bluetooth (Mobile)", "Hardwire (Original)"];

const REFERRAL_SPECS = {
  ihha: { requiresDetail: false },
  "qest4-ref": { requiresDetail: true },
  practitioner: { requiresDetail: true },
  "other-ref": { requiresDetail: true },
  none: { requiresDetail: false },
};

const TAX_CLASSIFICATIONS = ["individual", "c_corp", "s_corp", "partnership", "trust_estate", "llc", "other"];
const STATUSES = ["pending", "approved", "rejected", "blocked"];

// ── Parsing ──────────────────────────────────────────────────────────────

function sheetToRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const headers = (raw[0] || []).map((h) => String(h ?? "").trim());
  return raw
    .slice(1)
    .filter((row) => row.some((cell) => cell !== "" && cell !== null && cell !== undefined))
    .map((row, i) => {
      const obj = { _sheetRowNumber: i + 2 };
      headers.forEach((h, idx) => {
        if (h) obj[h] = row[idx];
      });
      return obj;
    });
}

export function parsePractitionerMigrationWorkbook(data) {
  const workbook = XLSX.read(data, { type: "array" });
  return {
    practitioners: sheetToRows(workbook, SHEET_NAMES.practitioners),
    credentials: sheetToRows(workbook, SHEET_NAMES.credentials),
    referralSources: sheetToRows(workbook, SHEET_NAMES.referralSources),
    paymentSetup: sheetToRows(workbook, SHEET_NAMES.paymentSetup),
    commissionPayout: sheetToRows(workbook, SHEET_NAMES.commissionPayout),
    w9: sheetToRows(workbook, SHEET_NAMES.w9),
  };
}

// ── Small shared helpers ─────────────────────────────────────────────────

function s(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

// Routing/account-number columns look purely numeric, so Excel silently
// stores them as a NUMBER unless the column is explicitly formatted as
// Text — which strips any leading zero before this code ever sees the
// value (e.g. "021000021" -> 21000021). A 9-digit ABA routing number is a
// fixed length, so a shorter all-digit value read back as a JS `number`
// is unambiguously a zero-stripped routing number — safe to re-pad. Only
// applies when the raw cell was a `number` (a string "21000021" typed on
// purpose is left alone, since that's not this failure mode).
function routingDigits(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(Math.trunc(v)).padStart(9, "0");
  }
  return s(v);
}
function lc(v) {
  return s(v).toLowerCase();
}
function bool(v) {
  return String(v).trim().toUpperCase() === "TRUE" || v === true || v === 1;
}
function dateOrNull(v) {
  if (!v && v !== 0) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ABA routing-number checksum — same algorithm as
// registration-form/src/schema/step3.schema.js's client-side check,
// duplicated here so the importer catches a bad routing number before
// ever calling NMI.
function isValidABA(routing) {
  if (!/^\d{9}$/.test(String(routing || ""))) return false;
  const d = String(routing).split("").map(Number);
  const sum = 3 * d[0] + 7 * d[1] + d[2] + 3 * d[3] + 7 * d[4] + d[5] + 3 * d[6] + 7 * d[7] + d[8];
  return sum % 10 === 0;
}

function generateBillingId(kind) {
  const rand = Math.random().toString(16).slice(2, 14);
  return `${kind}_${rand}`;
}

async function deleteNmiVaultWithRetry(vaultId, maxAttempts = 3) {
  if (!vaultId) return false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deleteCustomerVault(vaultId);
      return true;
    } catch (err) {
      log.warn("vault.rollback.retry", { vaultId, attempt, err: err?.message || err });
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  log.error("vault.rollback.exhausted", { vaultId });
  return false;
}

// Best-effort: fetch a remote file URL and re-host it on Shopify Files,
// exactly like a live upload. Never throws — returns null on failure so a
// bad/dead reference URL degrades to "no file" rather than aborting the
// practitioner's whole import.
async function rehostFileUrl(admin, url, label) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const filename = label || url.split("/").pop() || "upload";
    const file = new File([buf], filename, { type: contentType });
    return await uploadFileToShopify(admin, file);
  } catch (err) {
    log.warn("migration.file_rehost_failed", { url, error: err?.message || err });
    return null;
  }
}

// ── Report scaffolding ───────────────────────────────────────────────────

function newSection() {
  return { total: 0, created: 0, updated: 0, alreadyExists: 0, skipped: 0, errors: [], warnings: [] };
}
function pushError(section, rowId, message) {
  section.errors.push({ row_id: rowId, message });
}
function pushWarning(section, rowId, message) {
  section.warnings.push({ row_id: rowId, message });
}

// ── Main entry point ─────────────────────────────────────────────────────

// `admin` is the authenticated Shopify Admin GraphQL client for THIS shop
// (from `authenticate.admin(request)` in the route — unlike the GoAffPro
// importer, this app is single-tenant so no cross-shop resolution is
// needed). `commit=false` validates + reports without any Mongo write, NMI
// call, or Shopify call. `commit=true` performs the real per-practitioner
// pipeline.
export async function runPractitionerMigrationImport({ parsed, admin, shop, actor, commit }) {
  await connectDB();

  const report = {
    dryRun: !commit,
    practitioners: newSection(),
    credentials: newSection(),
    referralSources: newSection(),
    paymentSetup: newSection(),
    commissionPayout: newSection(),
    w9: newSection(),
  };

  // ── 1. Practitioners — validate + dedupe against existing wholesale_applications ──
  const practitioners = new Map(); // email -> { skip, reason, data }
  const seenEmails = new Set();
  for (const row of parsed.practitioners) {
    report.practitioners.total += 1;
    const email = lc(row.email);
    const rowId = row.row_id ?? row._sheetRowNumber;
    if (!email) {
      pushError(report.practitioners, rowId, "email is required");
      continue;
    }
    if (seenEmails.has(email)) {
      pushError(report.practitioners, rowId, `Duplicate email "${email}" on the Practitioners sheet — only the first row is used`);
      continue;
    }
    seenEmails.add(email);

    const declaredStatus = s(row.match_status).toUpperCase();
    const existingDoc = await WholesaleApplication.findOne({
      email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })
      .select("_id")
      .lean();

    if (existingDoc) {
      report.practitioners.alreadyExists += 1;
      if (declaredStatus === "NEW") {
        pushWarning(report.practitioners, rowId, `Declared match_status=NEW but "${email}" already has a wholesale_applications record — skipped, not overwritten`);
      }
      practitioners.set(email, { skip: true, reason: "already exists" });
      continue;
    }
    if (declaredStatus === "ALREADY_EXISTS") {
      pushWarning(report.practitioners, rowId, `Declared match_status=ALREADY_EXISTS but no matching record was found for "${email}" — will be created as new`);
    }

    const errs = [];
    const req = (field, val) => {
      if (!s(val)) errs.push(`${field} is required`);
    };
    req("first_name", row.first_name);
    req("last_name", row.last_name);
    req("phone", row.phone);
    req("billing_line1", row.billing_line1);
    req("billing_city", row.billing_city);
    req("billing_state", row.billing_state);
    req("billing_zip", row.billing_zip);
    req("billing_country", row.billing_country);

    const shippingSameAsBilling = bool(row.shipping_same_as_billing);
    if (!shippingSameAsBilling) {
      req("shipping_line1", row.shipping_line1);
      req("shipping_city", row.shipping_city);
      req("shipping_state", row.shipping_state);
      req("shipping_zip", row.shipping_zip);
      req("shipping_country", row.shipping_country);
    }
    if (!["Residential", "Commercial"].includes(s(row.shipping_property_type))) {
      errs.push(`shipping_property_type must be "Residential" or "Commercial" (got "${row.shipping_property_type}")`);
    }

    const taxIdType = lc(row.tax_id_type);
    if (!["ein", "ssn"].includes(taxIdType)) {
      errs.push(`tax_id_type must be "ein" or "ssn" (got "${row.tax_id_type}")`);
    }
    req("tax_id", row.tax_id);
    req("exempt_state", row.exempt_state);
    req("items_to_resell", row.items_to_resell);
    req("business_activity", row.business_activity);

    const status = STATUSES.includes(lc(row.status)) ? lc(row.status) : "approved";
    const termsAccepted = bool(row.terms_accepted);
    if (status === "approved" && !termsAccepted) {
      errs.push("terms_accepted must be TRUE for a practitioner migrating with status=approved");
    }
    if (status === "blocked" && !dateOrNull(row.blocked_at)) {
      errs.push("blocked_at is required for a practitioner migrating with status=blocked");
    }

    if (errs.length) {
      report.practitioners.skipped += 1;
      pushError(report.practitioners, rowId, errs.join("; "));
      practitioners.set(email, { skip: true, reason: "validation failed" });
      continue;
    }

    practitioners.set(email, {
      skip: false,
      rowId,
      data: {
        firstName: s(row.first_name),
        lastName: s(row.last_name),
        email,
        phone: s(row.phone),
        businessName: s(row.business_name) || null,
        billingAddress: {
          line1: s(row.billing_line1),
          line2: s(row.billing_line2) || null,
          city: s(row.billing_city),
          state: s(row.billing_state),
          zip: s(row.billing_zip),
          country: s(row.billing_country),
        },
        shippingSameAsBilling,
        shippingAddress: shippingSameAsBilling
          ? null
          : {
              line1: s(row.shipping_line1),
              line2: s(row.shipping_line2) || null,
              city: s(row.shipping_city),
              state: s(row.shipping_state),
              zip: s(row.shipping_zip),
              country: s(row.shipping_country),
            },
        shippingPropertyType: s(row.shipping_property_type),
        resellsProducts: bool(row.resells_products),
        tax: {
          taxIdType,
          taxId: s(row.tax_id),
          salesPermit: s(row.sales_permit) || null,
          exemptState: s(row.exempt_state),
          itemsToResell: s(row.items_to_resell),
          businessActivity: s(row.business_activity),
        },
        termsAccepted,
        subscribeNews: bool(row.subscribe_news),
        status,
        submittedAt: dateOrNull(row.submitted_at) || new Date(),
        reviewedAt: dateOrNull(row.reviewed_at),
        blockedAt: dateOrNull(row.blocked_at),
        existingShopifyCustomerId: s(row.existing_shopify_customer_id) || null,
        referredByPractitionerEmail: lc(row.referred_by_practitioner_email) || null,
        pdffillerSubmissionId: s(row.pdffiller_submission_id) || null,
        pdffillerFormUrl: s(row.pdffiller_form_url) || null,
        notes: s(row.notes) || null,
        credentials: {},
        referrals: {},
      },
    });
    report.practitioners.created += 1; // "resolved for creation"
  }

  // ── 2. Credentials ──
  for (const row of parsed.credentials) {
    report.credentials.total += 1;
    const rowId = row.row_id ?? row._sheetRowNumber;
    const email = lc(row.practitioner_email);
    const practitioner = practitioners.get(email);
    if (!practitioner) {
      pushError(report.credentials, rowId, `practitioner_email "${email}" was not found on the Practitioners sheet`);
      continue;
    }
    if (practitioner.skip) {
      report.credentials.skipped += 1;
      continue;
    }
    const credentialId = lc(row.credential_id);
    const spec = CREDENTIAL_SPECS[credentialId];
    if (!spec) {
      pushError(report.credentials, rowId, `Unknown credential_id "${row.credential_id}"`);
      continue;
    }
    const errs = [];
    const values = [s(row.detail_value_1), s(row.detail_value_2)];
    spec.textKeys.forEach((key, i) => {
      if (!values[i]) errs.push(`${key} is required for credential "${credentialId}"`);
    });
    if (credentialId === "qest4" && values[1] && !QEST4_SYSTEM_TYPES.includes(values[1])) {
      errs.push(`systemType must be one of: ${QEST4_SYSTEM_TYPES.join(", ")} (got "${values[1]}")`);
    }
    if (spec.fileKey && !s(row.file_url)) {
      errs.push(`file_url is required for credential "${credentialId}"`);
    }
    if (errs.length) {
      pushError(report.credentials, rowId, errs.join("; "));
      continue;
    }

    const entry = { selected: true };
    spec.textKeys.forEach((key, i) => {
      entry[key] = values[i];
    });
    if (spec.fileKey) entry[spec.fileKey] = s(row.file_url); // re-hosted at commit time
    practitioner.data.credentials[credentialId] = entry;
    report.credentials.created += 1;
  }

  // ── 3. Referral_Sources ──
  for (const row of parsed.referralSources) {
    report.referralSources.total += 1;
    const rowId = row.row_id ?? row._sheetRowNumber;
    const email = lc(row.practitioner_email);
    const practitioner = practitioners.get(email);
    if (!practitioner) {
      pushError(report.referralSources, rowId, `practitioner_email "${email}" was not found on the Practitioners sheet`);
      continue;
    }
    if (practitioner.skip) {
      report.referralSources.skipped += 1;
      continue;
    }
    const referralId = lc(row.referral_id);
    const spec = REFERRAL_SPECS[referralId];
    if (!spec) {
      pushError(report.referralSources, rowId, `Unknown referral_id "${row.referral_id}"`);
      continue;
    }
    if (spec.requiresDetail && !s(row.detail_value)) {
      pushError(report.referralSources, rowId, `detail_value is required for referral "${referralId}"`);
      continue;
    }
    practitioner.data.referrals[referralId] = spec.requiresDetail
      ? { selected: true, value: s(row.detail_value) }
      : { selected: true };
    report.referralSources.created += 1;
  }

  // ── 4. Payment_Setup (required, 1 per NEW practitioner) ──
  const paymentByEmail = new Map();
  for (const row of parsed.paymentSetup) {
    report.paymentSetup.total += 1;
    const rowId = row.row_id ?? row._sheetRowNumber;
    const email = lc(row.practitioner_email);
    const practitioner = practitioners.get(email);
    if (!practitioner) {
      pushError(report.paymentSetup, rowId, `practitioner_email "${email}" was not found on the Practitioners sheet`);
      continue;
    }
    if (practitioner.skip) {
      report.paymentSetup.skipped += 1;
      continue;
    }
    if (paymentByEmail.has(email)) {
      pushError(report.paymentSetup, rowId, `Duplicate Payment_Setup row for "${email}" — only one is allowed`);
      continue;
    }
    const method = lc(row.preferred_payment_method);
    if (!["card", "ach", "check"].includes(method)) {
      pushError(report.paymentSetup, rowId, `preferred_payment_method must be card, ach, or check (got "${row.preferred_payment_method}")`);
      continue;
    }
    const errs = [];
    if (!s(row.cardholder_name)) errs.push("cardholder_name is required (every account needs a card-on-file name, even if the card token isn't captured yet)");
    let achRoutingNumber = null;
    let achAccountNumber = null;
    if (method === "ach") {
      achRoutingNumber = routingDigits(row.ach_routing_number);
      achAccountNumber = s(row.ach_account_number);
      if (!s(row.ach_account_name)) errs.push("ach_account_name is required");
      if (!/^\d{9}$/.test(achRoutingNumber) || !isValidABA(achRoutingNumber)) errs.push("ach_routing_number must be a valid 9-digit ABA routing number");
      if (!/^\d{4,17}$/.test(achAccountNumber)) errs.push("ach_account_number must be 4-17 digits");
      if (!s(row.ach_account_type)) errs.push("ach_account_type is required");
    }
    if (errs.length) {
      pushError(report.paymentSetup, rowId, errs.join("; "));
      continue;
    }
    const needsCardCapture = method !== "ach";
    paymentByEmail.set(email, {
      method,
      cardholderName: s(row.cardholder_name),
      cardBrand: s(row.card_brand) || null,
      cardLast4: s(row.card_last4) || null,
      achAccountName: s(row.ach_account_name) || null,
      achRoutingNumber,
      achAccountNumber, // transient — never persisted; used once to create the NMI vault
      achAccountType: lc(row.ach_account_type) || null,
      needsCardCapture,
    });
    if (needsCardCapture) {
      pushWarning(
        report.paymentSetup,
        rowId,
        `preferred_payment_method="${method}" cannot create a working NMI vault from a spreadsheet — this practitioner will import with needsCardCapture=true (see plan §6)`,
      );
    }
    report.paymentSetup.created += 1;
  }
  for (const [email, practitioner] of practitioners) {
    if (!practitioner.skip && !paymentByEmail.has(email)) {
      pushError(report.paymentSetup, null, `Practitioner "${email}" has no Payment_Setup row — a payment method is required`);
    }
  }

  // ── 5. Commission_Payout (optional, 0-1 per practitioner) ──
  const commissionByEmail = new Map();
  for (const row of parsed.commissionPayout) {
    report.commissionPayout.total += 1;
    const rowId = row.row_id ?? row._sheetRowNumber;
    const email = lc(row.practitioner_email);
    const practitioner = practitioners.get(email);
    if (!practitioner) {
      pushError(report.commissionPayout, rowId, `practitioner_email "${email}" was not found on the Practitioners sheet`);
      continue;
    }
    if (practitioner.skip) {
      report.commissionPayout.skipped += 1;
      continue;
    }
    if (commissionByEmail.has(email)) {
      pushError(report.commissionPayout, rowId, `Duplicate Commission_Payout row for "${email}" — only one is allowed`);
      continue;
    }
    const payoutMethod = lc(row.payout_method);
    if (!["ach", "check"].includes(payoutMethod)) {
      pushError(report.commissionPayout, rowId, `payout_method must be ach or check (got "${row.payout_method}")`);
      continue;
    }
    const errs = [];
    let bankRoutingNumber = null;
    let bankAccountNumber = null;
    if (payoutMethod === "ach") {
      bankRoutingNumber = routingDigits(row.bank_routing_number);
      bankAccountNumber = s(row.bank_account_number);
      if (!s(row.bank_account_name)) errs.push("bank_account_name is required");
      if (!/^\d{9}$/.test(bankRoutingNumber) || !isValidABA(bankRoutingNumber)) errs.push("bank_routing_number must be a valid 9-digit ABA routing number");
      if (!/^\d{4,17}$/.test(bankAccountNumber)) errs.push("bank_account_number must be 4-17 digits");
      if (!s(row.bank_account_type)) errs.push("bank_account_type is required");
    } else {
      if (!s(row.check_payable_to)) errs.push("check_payable_to is required");
      const useBilling = bool(row.check_use_billing_address);
      if (!useBilling) {
        if (!s(row.check_mailing_line1)) errs.push("check_mailing_line1 is required when check_use_billing_address=FALSE");
        if (!s(row.check_mailing_city)) errs.push("check_mailing_city is required when check_use_billing_address=FALSE");
        if (!s(row.check_mailing_state)) errs.push("check_mailing_state is required when check_use_billing_address=FALSE");
        if (!s(row.check_mailing_zip)) errs.push("check_mailing_zip is required when check_use_billing_address=FALSE");
        if (!s(row.check_mailing_country)) errs.push("check_mailing_country is required when check_use_billing_address=FALSE");
      }
    }
    if (errs.length) {
      pushError(report.commissionPayout, rowId, errs.join("; "));
      continue;
    }
    commissionByEmail.set(email, {
      payoutMethod,
      bankAccountName: s(row.bank_account_name) || null,
      bankRoutingNumber,
      bankAccountNumber, // transient — encrypted (or discarded) at commit time
      bankAccountType: lc(row.bank_account_type) || null,
      check:
        payoutMethod === "check"
          ? {
              payableTo: s(row.check_payable_to),
              useBillingAddress: bool(row.check_use_billing_address),
              mailingAddress: bool(row.check_use_billing_address)
                ? null
                : {
                    line1: s(row.check_mailing_line1),
                    line2: s(row.check_mailing_line2) || null,
                    city: s(row.check_mailing_city),
                    state: s(row.check_mailing_state),
                    zip: s(row.check_mailing_zip),
                    country: s(row.check_mailing_country),
                  },
            }
          : null,
    });
    report.commissionPayout.created += 1;
  }

  // ── 6. W9_Tax_Certification (required, 1 per NEW practitioner) ──
  const w9ByEmail = new Map();
  for (const row of parsed.w9) {
    report.w9.total += 1;
    const rowId = row.row_id ?? row._sheetRowNumber;
    const email = lc(row.practitioner_email);
    const practitioner = practitioners.get(email);
    if (!practitioner) {
      pushError(report.w9, rowId, `practitioner_email "${email}" was not found on the Practitioners sheet`);
      continue;
    }
    if (practitioner.skip) {
      report.w9.skipped += 1;
      continue;
    }
    if (w9ByEmail.has(email)) {
      pushError(report.w9, rowId, `Duplicate W9_Tax_Certification row for "${email}" — only one is allowed`);
      continue;
    }
    const taxClassification = lc(row.tax_classification);
    const errs = [];
    if (!s(row.legal_name)) errs.push("legal_name is required");
    if (!TAX_CLASSIFICATIONS.includes(taxClassification)) errs.push(`tax_classification must be one of: ${TAX_CLASSIFICATIONS.join(", ")}`);
    let llcClassification = null;
    if (taxClassification === "llc") {
      llcClassification = s(row.llc_classification).toUpperCase();
      if (!["C", "S", "P"].includes(llcClassification)) errs.push("llc_classification must be C, S, or P when tax_classification=llc");
    }
    if (taxClassification === "other" && !s(row.other_classification)) {
      errs.push("other_classification is required when tax_classification=other");
    }
    const signatureType = lc(row.signature_type);
    if (!["drawn", "typed"].includes(signatureType)) errs.push('signature_type must be "drawn" or "typed"');
    if (!s(row.signature_value_or_file_url)) errs.push("signature_value_or_file_url is required");
    const signedAt = dateOrNull(row.signed_at);
    if (!signedAt) errs.push("signed_at is required");
    if (errs.length) {
      pushError(report.w9, rowId, errs.join("; "));
      continue;
    }
    w9ByEmail.set(email, {
      legalName: s(row.legal_name),
      taxClassification,
      llcClassification,
      otherClassification: taxClassification === "other" ? s(row.other_classification) : null,
      exemptPayeeCode: s(row.exempt_payee_code) || null,
      fatcaCode: s(row.fatca_code) || null,
      signatureType,
      signatureValueOrFileUrl: s(row.signature_value_or_file_url),
      signedAt,
    });
    report.w9.created += 1;
  }
  for (const [email, practitioner] of practitioners) {
    if (!practitioner.skip && !w9ByEmail.has(email)) {
      pushError(report.w9, null, `Practitioner "${email}" has no W9_Tax_Certification row — a signed W-9 is required`);
      practitioner.skip = true;
      practitioner.reason = "missing W-9";
    }
  }

  if (!commit) {
    return report;
  }

  // ── Commit: create each resolved practitioner through the real pipeline ──
  for (const [email, practitioner] of practitioners) {
    if (practitioner.skip) continue;
    const payment = paymentByEmail.get(email);
    const w9Row = w9ByEmail.get(email);
    if (!payment || !w9Row) continue; // already flagged as an error above

    const data = practitioner.data;
    let nmiCustomerVaultId = null;
    let cardBillingId = null;

    if (data.status === "approved" && payment.method === "ach") {
      cardBillingId = generateBillingId("card");
      try {
        nmiCustomerVaultId = await createCustomerVault({
          profile: {
            firstName: data.firstName,
            lastName: data.lastName,
            email: data.email,
            phone: data.phone,
            companyName: data.businessName,
            billingAddress: data.billingAddress,
          },
          paymentDetails: {
            achRouting: payment.achRoutingNumber,
            achAccount: payment.achAccountNumber,
            achAccountType: payment.achAccountType || "checking",
            checkName: payment.achAccountName,
          },
          billingId: generateBillingId("ach"),
        });
      } catch (err) {
        pushError(report.practitioners, practitioner.rowId, `NMI vault creation failed for "${email}": ${err?.message || err}`);
        continue;
      }
    }

    const achAccountLast4 = payment.achAccountNumber ? payment.achAccountNumber.slice(-4) : null;

    let commissionDoc = null;
    const commissionRow = commissionByEmail.get(email);
    if (commissionRow) {
      if (commissionRow.payoutMethod === "ach") {
        commissionDoc = {
          enabled: true,
          payoutMethod: "ach",
          bankAccountName: commissionRow.bankAccountName,
          bankRoutingNumber: commissionRow.bankRoutingNumber,
          bankAccountEncrypted: encryptField(commissionRow.bankAccountNumber),
          bankAccountLast4: commissionRow.bankAccountNumber.slice(-4),
          bankAccountType: commissionRow.bankAccountType,
          updatedAt: new Date(),
        };
      } else {
        commissionDoc = {
          enabled: true,
          payoutMethod: "check",
          check: commissionRow.check,
          updatedAt: new Date(),
        };
      }
    }

    const signature = {
      type: w9Row.signatureType,
      value: w9Row.signatureValueOrFileUrl,
      signedAt: w9Row.signedAt,
    };

    const payload = {
      shop,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      businessName: data.businessName,
      phone: data.phone,
      billingAddress: data.billingAddress,
      shippingSameAsBilling: data.shippingSameAsBilling,
      shippingAddress: data.shippingAddress,
      shippingPropertyType: data.shippingPropertyType,
      credentials: data.credentials,
      referrals: data.referrals,
      resellsProducts: data.resellsProducts,
      tax: data.tax,
      payment: {
        method: payment.method,
        card: {
          cardholderName: payment.cardholderName,
          cardBrand: payment.cardBrand,
          cardLast4: payment.cardLast4,
          paymentToken: null,
          nmi_billing_id: cardBillingId,
        },
        ach:
          payment.method === "ach"
            ? {
                achAccountName: payment.achAccountName,
                achRoutingNumber: payment.achRoutingNumber,
                achAccountLast4: achAccountLast4,
                achAccountType: payment.achAccountType,
                nmi_billing_id: null, // ACH IS the vault's primary billing here, not a secondary one
              }
            : null,
      },
      signature,
      commission: commissionDoc,
      w9: {
        legalName: w9Row.legalName,
        taxClassification: w9Row.taxClassification,
        llcClassification: w9Row.llcClassification,
        otherClassification: w9Row.otherClassification,
        exemptPayeeCode: w9Row.exemptPayeeCode,
        fatcaCode: w9Row.fatcaCode,
        signature,
        submittedAt: w9Row.signedAt,
      },
      termsAccepted: data.termsAccepted,
      subscribeNews: data.subscribeNews,
      status: data.status,
      submittedAt: data.submittedAt,
      reviewedAt: data.status === "approved" ? data.reviewedAt || new Date() : data.reviewedAt,
      blockedAt: data.status === "blocked" ? data.blockedAt : null,
      referredBy: data.referredByPractitionerEmail
        ? { email: data.referredByPractitionerEmail, source: "pdffiller_migration" }
        : null,
      nmiCustomerVaultId,
      // Non-schema fields (strict:false) — traceability + the card-capture
      // flag, never read by the live registration/order pipeline.
      migratedFromPdffiller: true,
      pdffillerSubmissionId: data.pdffillerSubmissionId,
      pdffillerFormUrl: data.pdffillerFormUrl,
      needsCardCapture: data.status === "approved" ? payment.needsCardCapture : false,
      migrationNotes: data.notes,
      migrationImportedBy: actor,
    };

    let app;
    try {
      app = await WholesaleApplication.create(payload);
    } catch (err) {
      await deleteNmiVaultWithRetry(nmiCustomerVaultId);
      pushError(report.practitioners, practitioner.rowId, `Failed to save practitioner "${email}": ${err?.message || err}`);
      continue;
    }
    report.practitioners.updated += 1; // "actually written" (created was used for the pre-commit resolved count)

    // Re-host credential + signature files best-effort — a failure here
    // never blocks the account from existing, it just leaves that one
    // file unattached for an admin to add manually.
    if (admin) {
      for (const [credId, entry] of Object.entries(app.credentials || {})) {
        const spec = CREDENTIAL_SPECS[credId];
        if (!spec?.fileKey || !entry[spec.fileKey]) continue;
        const hosted = await rehostFileUrl(admin, entry[spec.fileKey], `${credId}-${email}`);
        if (hosted) {
          app.credentials[`${credId}`][spec.fileKey] = hosted;
          app.markModified("credentials");
        } else {
          pushWarning(report.credentials, null, `Could not re-host license file for "${email}" (${credId}) — left as the original PDFfiller URL`);
        }
      }
      if (signature.type === "drawn") {
        const hosted = await rehostFileUrl(admin, signature.value, `signature-${email}`);
        if (hosted) {
          app.signature.value = hosted;
          app.w9.signature.value = hosted;
          app.markModified("signature");
          app.markModified("w9");
        } else {
          pushWarning(report.w9, null, `Could not re-host signature image for "${email}" — left as the original PDFfiller URL`);
        }
      }
      await app.save();
    }

    // 'blocked' mirrors the live block.js convention (Shopify tag swap
    // Approved->Blocked) but ONLY against an already-known/found customer —
    // there's no live path that blocks a customer who was never approved,
    // so migrating a blocked practitioner never creates a new one.
    // 'pending'/'rejected' have no Shopify-side representation anywhere in
    // the live system today, so they're intentionally left Mongo-only —
    // inventing a convention the rest of the app doesn't share would be
    // worse than leaving it for manual admin follow-up.
    if (data.status !== "approved" && data.status !== "blocked") {
      continue;
    }

    try {
      if (!admin) throw new Error("admin client unavailable");
      const note = buildShopifyNote(payload);

      // Preserving existing data (this migration's hard requirement) means
      // NEVER blindly `createCustomer`-ing over a practitioner who already
      // has a real Shopify account from before this system existed — that
      // would either fail outright (email taken) or, worse, silently
      // orphan their order history from the newly-created duplicate. Try
      // to resolve the real existing customer FIRST: an explicit
      // existing_shopify_customer_id column wins (operator already knows
      // it); otherwise look it up by email.
      let customerId = data.existingShopifyCustomerId || null;
      if (!customerId) {
        const found = await findCustomerByEmail(admin, data.email);
        customerId = found?.id || null;
      }

      if (customerId) {
        const addTags = data.status === "blocked" ? ["Blocked", "practitioner"] : ["Approved", "practitioner"];
        const removeTags = data.status === "blocked" ? ["Approved"] : ["Blocked"];
        await updateCustomerTagsAndNote(admin, { customerId, addTags, removeTags, note });
        app.customerId = customerId;
        app.shopifyCreateFailed = false;
        app.shopifyCreateError = null;
        await app.save();
        pushWarning(
          report.practitioners,
          practitioner.rowId,
          `Practitioner "${email}" linked to their EXISTING Shopify customer (${customerId}) instead of creating a new one — tags/note updated, order history preserved.`,
        );
      } else if (data.status === "approved") {
        customerId = await createCustomer(admin, {
          application: payload,
          note,
          tags: ["Approved", "practitioner"],
          subscribeNews: Boolean(payload.subscribeNews),
        });
        app.customerId = customerId;
        app.shopifyCreateFailed = false;
        app.shopifyCreateError = null;
        await app.save();
      } else {
        // status === 'blocked' and no existing customer was found — there
        // is nothing to block; skip Shopify entirely, Mongo doc already saved.
        continue;
      }

      if (data.status === "approved") {
        try {
          const cdoResult = await generatePractitionerCode({
            applicationId: app._id,
            firstName: data.firstName,
            lastName: data.lastName,
            email: data.email,
            shop,
          });
          log.info("migration.cdo_code", { email, code: cdoResult.code, alreadyExisted: cdoResult.alreadyExisted });
        } catch (cdoErr) {
          pushWarning(report.practitioners, practitioner.rowId, `Practitioner "${email}" imported, but CDO referral code generation failed (non-fatal): ${cdoErr?.message || cdoErr}`);
        }

        // Do NOT send Shopify account-invite emails for migrated practitioners.
        // The platform authenticates via email OTP (one-time code) rather than
        // password-based accounts — sending an activation/password-set invite
        // is confusing and unnecessary. If an explicit invite is required for
        // a migration, call `sendCustomerInvite` from an admin tool instead.
        app.customerInviteSentAt = null;
        await app.save();
      }
    } catch (err) {
      // Deliberately non-fatal here (see file header) — the
      // WholesaleApplication doc + NMI vault are KEPT even if the Shopify
      // side fails, since a migrated practitioner very plausibly already
      // has a Shopify customer record from before this system existed.
      app.shopifyCreateFailed = true;
      app.shopifyCreateError = err instanceof ShopifyUserError ? err.userErrors.map((e) => e.message).join("; ") : err?.message || String(err);
      await app.save();
      pushWarning(
        report.practitioners,
        practitioner.rowId,
        `Practitioner "${email}" saved, but the Shopify side failed (non-fatal): ${app.shopifyCreateError}`,
      );
    }
  }

  return report;
}
