/* eslint-env node */
// Repair sweep for RETAIL QBO Inventory items whose InvStartDate is too late.
//
// QBO refuses any transaction dated BEFORE an inventory item's start date:
//   "Transaction date is prior to start date for inventory item"
// Items created before the 2026-07-31 fix got InvStartDate = TODAY (UTC), which
// breaks retail invoices AND drop-ship vendor bills — both stamp TxnDate from
// the ORDER date, so every order older than the day its item was synced was
// rejected (and a UTC-vs-company-timezone skew broke same-day orders too).
//
// The invoice/bill paths now self-heal (back-date the offending items + retry
// once) and new items are back-dated up front; this sweeps the whole catalog
// proactively so no order has to fail first. Idempotent.
//
// Run (from ns-retail/):
//   npm run fix:qbo-inventory-dates            # dry run (report only)
//   npm run fix:qbo-inventory-dates:apply      # apply
//   npm run fix:qbo-inventory-dates:apply -- --start-date=2025-01-01

import {
  retailInventoryStartYmd,
  backdateRetailItemInventoryStart,
  listRetailItems,
} from "../app/services/retailQbo/retailQbo.service.js";

const APPLY = process.argv.includes("--apply");
const startArg = process.argv.find((a) => a.startsWith("--start-date="));
const target = (startArg ? startArg.split("=")[1] : retailInventoryStartYmd()).slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
  console.error(`[fix:qbo-inventory-dates] invalid target date "${target}" (want YYYY-MM-DD)`);
  process.exit(1);
}

async function main() {
  console.log(
    `[fix:qbo-inventory-dates] target InvStartDate = ${target}` + (APPLY ? "" : " (dry run)"),
  );

  const items = await listRetailItems({ type: "Inventory" });
  console.log(`[fix:qbo-inventory-dates] ${items.length} Inventory item(s) in the retail realm`);

  const late = items.filter((it) => {
    const current = it.InvStartDate ? String(it.InvStartDate).slice(0, 10) : null;
    return !current || current > target;
  });
  console.log(`[fix:qbo-inventory-dates] ${late.length} need back-dating`);

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of late) {
    const label = `item ${it.Id} "${it.Name}" (SKU ${it.Sku || "—"}) InvStartDate=${it.InvStartDate || "(none)"}`;
    if (!APPLY) {
      console.log(`  would back-date ${label} → ${target}`);
      continue;
    }
    try {
      const result = await backdateRetailItemInventoryStart({ itemId: it.Id, startDate: target });
      if (result.changed) {
        fixed += 1;
        console.log(`  ✓ ${label} → ${target}`);
      } else {
        skipped += 1;
        console.log(`  · skipped ${label} (${result.reason})`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${label}: ${err?.message || err}`);
    }
  }

  if (!APPLY) {
    console.log("[fix:qbo-inventory-dates] dry run — no changes made. Re-run with --apply.");
  } else {
    console.log(
      `[fix:qbo-inventory-dates] done — fixed=${fixed} skipped=${skipped} failed=${failed}`,
    );
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[fix:qbo-inventory-dates] fatal:", err);
  process.exit(1);
});
