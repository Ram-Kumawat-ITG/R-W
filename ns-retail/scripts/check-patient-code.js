/* eslint-env node */
// Diagnose why a patient's practitioner discount code isn't auto-applying.
//
// Prints, for one patient email, the three things that MUST agree for the
// practitioner-discount Function to APPLY the code at checkout:
//   1. the customer's `code:<code>` Shopify TAG   (what the auto-apply reads)
//   2. the customer's `cdo.active_code` METAFIELD (what the Function enforces)
//   3. the Shopify discount for that code — its status + its `cdo/config.code`
//      + practitionerId + percentage
// and the customer's permanent `cdo.practitioner_id` binding.
//
// The common failure: the TAG says one code but `cdo.active_code` says another
// (the two are written by separate best-effort calls on assign), so the block
// applies a code the Function then DECLINES → silent no-discount.
//
// Run:
//   node --experimental-loader ./scripts/extensionless-loader.mjs --env-file-if-exists=.env scripts/check-patient-code.js --email=qofonaho@denipl.net
//   (optionally --code=durgesh15 to also inspect a specific discount)
// Read-only — touches nothing.

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import { unauthenticated } from "../app/shopify.server.js";

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=").trim() : null;
}

const EMAIL = arg("email");
const CODE_ARG = arg("code");

async function resolveRetailShop() {
  if (process.env.CDO_RETAIL_SHOP) return process.env.CDO_RETAIL_SHOP;
  const sessions = await mongoose.connection.db
    .collection("shopify_sessions")
    .find({ isOnline: false })
    .toArray();
  const shops = [...new Set(sessions.map((s) => s.shop).filter(Boolean))];
  if (shops.length === 1) return shops[0];
  throw new Error(
    `Set CDO_RETAIL_SHOP in .env — could not auto-resolve (found: ${shops.join(", ") || "none"}).`,
  );
}

function tagCode(tags) {
  for (const t of tags || []) {
    if (String(t).toLowerCase().startsWith("code:")) return String(t).split(":").slice(1).join(":").trim();
  }
  return null;
}

async function main() {
  if (!EMAIL) throw new Error("Pass --email=<patient email>");
  await connectDB();
  const shop = await resolveRetailShop();
  const { admin } = await unauthenticated.admin(shop);
  console.log(`\nShop: ${shop}\nPatient: ${EMAIL}\n${"─".repeat(60)}`);

  // ── Customer: tags + both cdo metafields ──
  const cRes = await admin.graphql(
    `query ($q: String!) {
      customers(first: 1, query: $q) {
        nodes {
          id email tags
          activeCode: metafield(namespace: "cdo", key: "active_code") { value }
          practitionerId: metafield(namespace: "cdo", key: "practitioner_id") { value }
        }
      }
    }`,
    { variables: { q: `email:${EMAIL}` } },
  );
  const customer = (await cRes.json())?.data?.customers?.nodes?.[0];
  if (!customer) {
    console.log("❌ No Shopify customer found for that email in this shop.");
    return;
  }
  const tag = tagCode(customer.tags);
  const activeCode = customer.activeCode?.value ? String(customer.activeCode.value).toLowerCase() : null;
  const practitionerId = customer.practitionerId?.value || null;

  console.log(`Customer id      : ${customer.id}`);
  console.log(`code: TAG        : ${tag || "(none)"}`);
  console.log(`cdo.active_code  : ${activeCode || "(none)"}`);
  console.log(`cdo.practitioner_id: ${practitionerId || "(none)"}`);

  // ── Discount(s) to inspect: the arg, the tag, and the active_code ──
  const codesToCheck = [...new Set([CODE_ARG, tag, activeCode].filter(Boolean).map((c) => String(c)))];
  console.log(`${"─".repeat(60)}\nDiscounts:`);
  for (const code of codesToCheck) {
    const dRes = await admin.graphql(
      `query ($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
          configMeta: metafield(namespace: "cdo", key: "config") { value }
          codeDiscount {
            __typename
            ... on DiscountCodeApp { title status }
            ... on DiscountCodeBasic { title status }
          }
        }
      }`,
      { variables: { code } },
    );
    const node = (await dRes.json())?.data?.codeDiscountNodeByCode;
    if (!node) {
      console.log(`  • "${code}": ❌ no Shopify discount with this code exists`);
      continue;
    }
    let cfg = {};
    try { cfg = node.configMeta?.value ? JSON.parse(node.configMeta.value) : {}; } catch { cfg = { _parseError: true }; }
    const d = node.codeDiscount || {};
    console.log(
      `  • "${code}": ${d.__typename} status=${d.status} ` +
        `config.code=${cfg.code ?? "(none)"} practitionerId=${cfg.practitionerId ?? "(none)"} pct=${cfg.percentage ?? "(none)"}`,
    );
  }

  // ── Verdict ──
  console.log(`${"─".repeat(60)}\nVerdict:`);
  if (!tag) console.log("  ⚠ No code: tag → the storefront auto-apply reads nothing and does nothing.");
  if (activeCode && tag && activeCode !== tag.toLowerCase()) {
    console.log(
      `  ❌ MISMATCH: tag "${tag}" ≠ cdo.active_code "${activeCode}". The block applies "${tag}" ` +
        `but the Function enforces "${activeCode}" → the code is DECLINED at checkout. This is the bug.`,
    );
  } else if (activeCode && tag && activeCode === tag.toLowerCase()) {
    console.log(`  ✓ tag and cdo.active_code agree ("${activeCode}"). If it still declines, check the discount status/config above.`);
  } else if (tag && !activeCode) {
    console.log(`  ⚠ cdo.active_code is EMPTY. The Function fails OPEN on an empty active_code, so the code should apply (for the bound practitioner). If it doesn't, the discount likely doesn't exist/active.`);
  }
}

main()
  .catch((e) => { console.error("\nFAILED:", e?.message || e); process.exitCode = 1; })
  .finally(async () => { await mongoose.connection.close().catch(() => {}); });
