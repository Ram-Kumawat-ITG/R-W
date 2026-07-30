// Retail CUSTOMER migration import — Phase 1 (customers only).
//
// Parses the workbook described in
// docs/migration/retail-customer-migration-plan.md +
// Retail_Customer_Migration_Template.xlsx, validates it, and (when
// commit=true) creates/adopts a Shopify customer in the STAGING store and
// upserts the matching cdo_applications doc.
//
// Scope guardrails:
//   • Writes ONLY: Shopify customers (create/adopt-by-link) + cdo_applications.
//   • Does NOT write referral/CDO attribution (code tags, cdo.active_code /
//     cdo.practitioner_id metafields, referral snapshot), orders, commissions,
//     payouts, or practitioner codes — that is a SEPARATE later phase. The
//     referral_* columns are reference-only and ignored here.
//   • Adopts an existing Shopify customer (by explicit id, else by email)
//     instead of creating a duplicate, preserving order history.
//   • Idempotent: re-running the same file relinks/updates rather than
//     duplicating (cdo_applications matched by (shop,email); Shopify by
//     id/email).
//
// Reliability: Shopify GraphQL is a leaky-bucket rate limiter that returns a
// 200 with { errors:[{extensions:{code:"THROTTLED"}}] } (NOT a 429). Every
// Shopify call is throttle-aware + retried with backoff, and rows are paced —
// this is the fix for the mass-throttle failure seen in the wholesale bulk
// migration.

import XLSX from "xlsx";
import connectDB from "../../db/mongo.server";
import CdoApplication from "../../models/cdoApplication.server";
import { retry, TransientError, PermanentError } from "../../utils/retry.utils";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("customerMigration.service");

const SHEET_NAME = "Customers";
const SHOPIFY_RETRY = { attempts: 8, baseMs: 1500, maxMs: 30000, factor: 2 };
const ROW_PACING_MS = 200; // gentle spacing between rows so the cost bucket refills

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLICANT_TYPES = new Set(["patient", "retailer"]);
const STATUSES = new Set(["pending", "approved", "rejected"]);
const SOURCES = new Set(["shopify", "wix"]);

// ── Parsing ────────────────────────────────────────────────────────────────

function sheetToRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  const headers = (raw[0] || []).map((h) => String(h ?? "").trim());
  return raw
    .slice(1)
    .filter((row) => row.some((c) => c !== "" && c !== null && c !== undefined))
    .map((row, i) => {
      const obj = { _sheetRowNumber: i + 2 };
      headers.forEach((h, idx) => {
        if (h) obj[h] = row[idx];
      });
      return obj;
    });
}

// `data` is a Uint8Array (route reads the uploaded File via .arrayBuffer()).
export function parseCustomerMigrationWorkbook(data) {
  const workbook = XLSX.read(data, { type: "array" });
  return { customers: sheetToRows(workbook, SHEET_NAME) };
}

// ── Small helpers ────────────────────────────────────────────────────────

function s(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}
function lc(v) {
  return s(v).toLowerCase();
}
function bool(v, dflt = false) {
  const t = s(v).toUpperCase();
  if (t === "") return dflt;
  return t === "TRUE" || t === "1" || t === "YES" || v === true || v === 1;
}
function dateOrNull(v) {
  if (!v && v !== 0) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Lenient E.164 for a US-centric retail store. Returns null (never throws) on
// an unparseable number so a bad phone can never abort a customer create.
function toE164(phone) {
  const trimmed = s(phone);
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits ? `+${digits}` : null;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`; // assume US
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

function readAddress(row, prefix) {
  return {
    line1: s(row[`${prefix}_line1`]),
    line2: s(row[`${prefix}_line2`]),
    city: s(row[`${prefix}_city`]),
    state: s(row[`${prefix}_state`]),
    zip: s(row[`${prefix}_zip`]),
    country: s(row[`${prefix}_country`]),
  };
}
function hasUsableAddress(a) {
  return Boolean(a && (a.line1 || a.city || a.zip));
}
// Map to a Shopify MailingAddressInput. Uses the (deprecated) full-name
// province/country fields, which tolerate BOTH full names and codes — avoids
// the province/country code-validation failures seen in the wholesale run.
function toShopifyAddress(a, firstName, lastName) {
  return {
    address1: a.line1 || "",
    address2: a.line2 || "",
    city: a.city || "",
    province: a.state || "",
    zip: a.zip || "",
    country: a.country || "",
    firstName,
    lastName,
  };
}
function normalizeCustomerGid(v) {
  const raw = s(v);
  if (!raw) return null;
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

// ── Shopify GraphQL (throttle-aware) ───────────────────────────────────────

async function retailGraphql(admin, query, variables) {
  return retry(async () => {
    let res;
    try {
      res = await admin.graphql(query, variables ? { variables } : undefined);
    } catch (err) {
      throw new TransientError(`Shopify GraphQL threw: ${err?.message || err}`, { cause: err });
    }
    const json = await res.json();
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    if (errors.length) {
      const throttled = errors.some((e) => {
        const code = e?.extensions?.code;
        return code === "THROTTLED" || code === "MAX_COST_EXCEEDED";
      });
      if (throttled) {
        throw new TransientError(`Shopify throttled: ${errors.map((e) => e.message).join("; ")}`);
      }
      // Non-throttle top-level errors = malformed/permission — permanent.
      throw new PermanentError(`Shopify GraphQL errors: ${errors.map((e) => e.message).join("; ")}`);
    }
    return json;
  }, SHOPIFY_RETRY);
}

const QUERY_CUSTOMER_BY_EMAIL = `#graphql
  query MigrationFindCustomer($q: String!) {
    customers(first: 1, query: $q) { edges { node { id email tags } } }
  }`;
const QUERY_CUSTOMER_BY_ID = `#graphql
  query MigrationGetCustomer($id: ID!) { customer(id: $id) { id email tags } }`;
const MUTATION_CUSTOMER_CREATE = `#graphql
  mutation MigrationCustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id email tags }
      userErrors { field message }
    }
  }`;
const MUTATION_CUSTOMER_UPDATE = `#graphql
  mutation MigrationCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id tags }
      userErrors { field message }
    }
  }`;

async function findCustomerByEmail(admin, email) {
  const json = await retailGraphql(admin, QUERY_CUSTOMER_BY_EMAIL, {
    q: `email:${email.replace(/["\\]/g, "\\$&")}`,
  });
  const node = json?.data?.customers?.edges?.[0]?.node;
  return node ? { id: node.id, email: node.email, tags: node.tags || [] } : null;
}
async function getCustomerById(admin, gid) {
  const json = await retailGraphql(admin, QUERY_CUSTOMER_BY_ID, { id: gid });
  const c = json?.data?.customer;
  return c ? { id: c.id, email: c.email, tags: c.tags || [] } : null;
}

function isAddressUserError(userErrors) {
  return userErrors.some((e) => {
    const f = Array.isArray(e.field) ? e.field.join(".") : String(e.field || "");
    return /address|province|country|zip/i.test(f) || /province|country|zip/i.test(e.message || "");
  });
}
// Shopify enforces phone uniqueness ACROSS customers, so a number shared by two
// real people (spouses, a household, a practitioner's number reused on patient
// records) fails the second create with "Phone has already been taken". The
// phone is incidental data on a migration — losing the customer over it is not
// acceptable, so it is dropped from the Shopify payload and kept in our own DB.
function isPhoneUserError(userErrors) {
  return userErrors.some((e) => {
    const f = Array.isArray(e.field) ? e.field.join(".") : String(e.field || "");
    return /phone/i.test(f) || /phone/i.test(e.message || "");
  });
}

// ── Report scaffolding ─────────────────────────────────────────────────────

function newSection() {
  return {
    total: 0,
    created: 0, // new Shopify customers
    adopted: 0, // existing Shopify customers linked
    appCreated: 0, // new cdo_applications docs
    appUpdated: 0, // existing cdo_applications docs updated
    alreadyLinked: 0, // already migrated, no-op
    skipped: 0, // row failed validation
    errors: [],
    warnings: [],
  };
}
function pushError(section, rowId, message) {
  section.errors.push({ row_id: rowId, message });
}
function pushWarning(section, rowId, message) {
  section.warnings.push({ row_id: rowId, message });
}

// ── Main entry point ───────────────────────────────────────────────────────

// commit=false → full validation + Shopify READ lookups, but no writes.
// commit=true  → same walk + actual Shopify creates/updates + Mongo upserts.
//
// `pacingMs`   — override ROW_PACING_MS (the CLI driver tunes this).
// `onProgress` — called after every row with { index, total, rowId, email,
//                outcome } so a long run can report progress and checkpoint as
//                it goes, instead of only revealing anything once the whole walk
//                finishes. Resume is the CALLER's job: scripts/migrate-retail-
//                customers.js filters already-linked rows out of `parsed` before
//                calling, so it can also size its chunks and ETA correctly.
export async function runCustomerMigrationImport({
  parsed,
  admin,
  shop,
  actor,
  commit,
  migrationRunId = null,
  pacingMs = ROW_PACING_MS,
  onProgress = null,
}) {
  await connectDB();
  const section = newSection();
  const report = { dryRun: !commit, migrationType: "retail_customer", actor: actor || null, customers: section };
  const rows = parsed?.customers || [];

  const prov = {
    migrationSource: "retail_customer",
    migrationRunId: migrationRunId || null,
  };

  const seenEmails = new Map(); // email → first row_id (in-sheet dedupe)

  let index = 0;
  for (const row of rows) {
    section.total += 1;
    index += 1;
    const rowId = s(row.row_id) || String(row._sheetRowNumber || section.total);

    // ── Validate ──
    const source = lc(row.source);
    const applicantType = lc(row.applicant_type) || "patient";
    const firstName = s(row.first_name);
    const lastName = s(row.last_name);
    const email = lc(row.email);

    // Hard requirements: a customer cannot exist without a source + a valid
    // email (the identity key). Name is NOT hard-required — Shopify permits an
    // email-only customer, and many migrated contacts (esp. Wix newsletter/
    // lead captures) have no name; blocking them would drop real customers.
    const rowErrors = [];
    if (!SOURCES.has(source)) rowErrors.push("source must be 'shopify' or 'wix'");
    if (!APPLICANT_TYPES.has(applicantType)) rowErrors.push("applicant_type must be 'patient' or 'retailer'");
    if (!EMAIL_REGEX.test(email)) rowErrors.push("email is missing or invalid");
    if (rowErrors.length) {
      pushError(section, rowId, rowErrors.join("; "));
      section.skipped += 1;
      onProgress?.({ index, total: rows.length, rowId, email, outcome: "invalid" });
      continue;
    }
    if (!firstName || !lastName) {
      pushWarning(section, rowId, "missing first/last name — imported email-only (name can be filled later)");
    }
    if (seenEmails.has(email)) {
      pushError(section, rowId, `duplicate email in sheet (first seen at row ${seenEmails.get(email)}) — keep one row per email`);
      section.skipped += 1;
      onProgress?.({ index, total: rows.length, rowId, email, outcome: "duplicate_in_sheet" });
      continue;
    }
    seenEmails.set(email, rowId);

    const businessName = s(row.business_name);
    if (applicantType === "retailer" && !businessName) {
      pushWarning(section, rowId, "retailer with no business_name — imported blank");
    }

    let status = lc(row.status) || "approved";
    if (!STATUSES.has(status)) {
      pushWarning(section, rowId, `unknown status "${row.status}" — defaulted to approved`);
      status = "approved";
    }

    const phoneRaw = s(row.phone);
    const phone = toE164(phoneRaw);
    if (phoneRaw && !phone) pushWarning(section, rowId, `phone "${phoneRaw}" not parseable — imported without a phone`);

    const acceptsMarketing = bool(row.accepts_marketing, false);
    const shippingSame = bool(row.shipping_same_as_billing, true);
    const billing = readAddress(row, "billing");
    const shipping = shippingSame ? null : readAddress(row, "shipping");
    const extraTags = s(row.extra_tags)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const migrationTags = ["Migrated", `migrated:${source}`, ...extraTags];
    const sourceCustomerId = s(row.source_customer_id);
    const explicitExistingGid = normalizeCustomerGid(row.existing_shopify_customer_id);
    const notes = s(row.notes);

    let outcome = "failed";
    try {
      // ── Resolve the target Shopify customer ──
      let existing = null;
      if (explicitExistingGid) {
        existing = await getCustomerById(admin, explicitExistingGid);
        if (!existing) pushWarning(section, rowId, `existing_shopify_customer_id ${explicitExistingGid} not found — falling back to email match / create`);
      }
      if (!existing) existing = await findCustomerByEmail(admin, email);

      let shopifyCustomerGid = existing?.id || null;

      if (commit) {
        if (existing) {
          // ── Adopt: add migration tags, preserve everything else ──
          const nextTags = Array.from(new Set([...(existing.tags || []), ...migrationTags]));
          if (nextTags.length !== (existing.tags || []).length) {
            await retailGraphql(admin, MUTATION_CUSTOMER_UPDATE, {
              input: { id: existing.id, tags: nextTags },
            });
          }
          section.adopted += 1;
        } else {
          // ── Create ──
          const input = {
            email,
            tags: migrationTags,
            emailMarketingConsent: {
              marketingState: acceptsMarketing ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
              marketingOptInLevel: acceptsMarketing ? "SINGLE_OPT_IN" : null,
              consentUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
            },
          };
          if (firstName) input.firstName = firstName;
          if (lastName) input.lastName = lastName;
          if (phone) input.phone = phone;
          const addresses = [];
          if (hasUsableAddress(billing)) addresses.push(toShopifyAddress(billing, firstName, lastName));
          if (shipping && hasUsableAddress(shipping)) addresses.push(toShopifyAddress(shipping, firstName, lastName));
          if (addresses.length) input.addresses = addresses;

          let res = await retailGraphql(admin, MUTATION_CUSTOMER_CREATE, { input });
          let ue = res?.data?.customerCreate?.userErrors || [];

          // Remediate the two optional fields Shopify can reject, one at a time,
          // rather than losing the customer over incidental data. Each stripped
          // field is still persisted on our own cdo_applications doc. The guard
          // bounds this at one attempt per field so a genuinely broken row falls
          // through to the error path instead of looping.
          const stripped = new Set();
          for (let guard = 0; ue.length && guard < 2; guard++) {
            if (input.addresses && !stripped.has("addresses") && isAddressUserError(ue)) {
              pushWarning(section, rowId, `Shopify rejected the address (${ue.map((e) => e.message).join("; ")}) — customer created without it; address kept in our DB`);
              delete input.addresses;
              stripped.add("addresses");
            } else if (input.phone && !stripped.has("phone") && isPhoneUserError(ue)) {
              pushWarning(section, rowId, `Shopify rejected the phone "${phone}" (${ue.map((e) => e.message).join("; ")}) — Shopify requires phone numbers to be unique across customers, so the customer was created without it; phone kept in our DB`);
              delete input.phone;
              stripped.add("phone");
            } else {
              break;
            }
            res = await retailGraphql(admin, MUTATION_CUSTOMER_CREATE, { input });
            ue = res?.data?.customerCreate?.userErrors || [];
          }
          // Email already taken (race / pre-existing) → adopt by email.
          if (ue.length && ue.some((e) => /taken|already/i.test(e.message || ""))) {
            const found = await findCustomerByEmail(admin, email);
            if (found) {
              const nextTags = Array.from(new Set([...(found.tags || []), ...migrationTags]));
              await retailGraphql(admin, MUTATION_CUSTOMER_UPDATE, { input: { id: found.id, tags: nextTags } });
              shopifyCustomerGid = found.id;
              section.adopted += 1;
            } else {
              throw new Error(`customerCreate failed: ${ue.map((e) => e.message).join("; ")}`);
            }
          } else if (ue.length) {
            throw new Error(`customerCreate failed: ${ue.map((e) => e.message).join("; ")}`);
          } else {
            shopifyCustomerGid = res?.data?.customerCreate?.customer?.id || null;
            if (!shopifyCustomerGid) throw new Error("customerCreate returned no customer");
            section.created += 1;
          }
        }

        // ── Upsert cdo_applications (email-keyed, shop-scoped) ──
        const doc = await CdoApplication.findOne({ shop, email });
        const fields = {
          applicantType,
          firstName,
          lastName,
          email,
          businessName: businessName || undefined,
          phone: phoneRaw || undefined,
          billingAddress: hasUsableAddress(billing) ? billing : null,
          shippingAddress: shipping && hasUsableAddress(shipping) ? shipping : null,
          status,
          customerId: shopifyCustomerGid,
          ...prov,
          migrationSourceStore: source,
          migrationSourceId: sourceCustomerId || undefined,
          migrationNotes: notes || undefined,
        };
        if (doc) {
          if (doc.customerId === shopifyCustomerGid && doc.migrationRunId) {
            section.alreadyLinked += 1;
          } else {
            Object.assign(doc, fields);
            await doc.save();
            section.appUpdated += 1;
          }
        } else {
          await CdoApplication.create({
            shop,
            submittedAt: dateOrNull(row.source_created_at) || new Date(),
            reviewedAt: null,
            referral: null, // Phase 2 owns referral/CDO attribution
            ...fields,
          });
          section.appCreated += 1;
        }
      } else {
        // ── Dry run: count the intended outcome without writing ──
        if (existing) section.adopted += 1;
        else section.created += 1;
        void shopifyCustomerGid;
      }
      outcome = "ok";
    } catch (err) {
      pushError(section, rowId, err?.message || String(err));
      section.skipped += 1;
      outcome = "failed";
      log.error("row.failed", { rowId, email, err: err?.message || String(err) });
    }

    onProgress?.({ index, total: rows.length, rowId, email, outcome });

    if (commit && pacingMs) await new Promise((r) => setTimeout(r, pacingMs));
  }

  return report;
}
