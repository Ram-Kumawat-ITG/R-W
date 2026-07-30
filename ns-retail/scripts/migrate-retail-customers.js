/* eslint-env node */
// Resumable CLI driver for the retail CUSTOMER migration (Phase 1).
//
// WHY THIS EXISTS
// The admin page (app.customer-migration.jsx) runs the whole import inside a
// single HTTP action. At ~0.9s/row a 4,836-row workbook needs 70+ minutes, so
// the request is killed by the platform long before the loop ends. Customers
// already created in Shopify persist, but the route only writes its report
// AFTER the loop — so every killed run left a cdo_migration_runs doc containing
// nothing but { migrationType }, with no progress, no error and no failed-row
// list. That is exactly what happened: three attempts, 3,549 of 4,836 rows
// linked, and no record of which rows were left or why.
//
// A terminal process has no request timeout, so this driver does the same import
// with the pieces the route cannot provide:
//   • RESUME  — state is derived from the DATABASE, not a checkpoint file, so it
//               is correct even after a hard kill: any email already linked in
//               cdo_applications is skipped without spending a Shopify call.
//   • NO DUPES— it delegates every row to the same runCustomerMigrationImport()
//               the admin page uses, which resolves an existing customer by
//               explicit id then by email and ADOPTS it (adds tags, preserves
//               order history) instead of creating a second one. Re-running is
//               therefore always safe.
//   • FAILURES— written to their own CSV + JSONL as they happen, so a crash can
//               never lose them, and re-fed automatically for one retry pass.
//   • THROTTLE— inherited from the service: Shopify answers a rate-limit with a
//               200 + { errors:[{extensions:{code:"THROTTLED"}}] }, which the
//               service classifies as transient and retries with backoff
//               (8 attempts, 1.5s→30s) on top of per-row pacing.
//   • PROGRESS— the audit run doc is rewritten after EVERY chunk, so progress
//               survives a kill and the admin page's "Recent Committed Runs"
//               table shows real numbers.
//
// SAFE BY DEFAULT: dry run unless you pass --apply.
//
//   npm run migrate:retail-customers              # dry run, shows what remains
//   npm run migrate:retail-customers:apply        # do it
//   npm run migrate:retail-customers:apply -- --only-failed=<failures.csv>
//
// Ctrl-C is safe: the current row finishes, logs and the audit doc are flushed,
// and the next run picks up exactly where this one stopped.

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoApplication from "../app/models/cdoApplication.server.js";
import CdoMigrationRun from "../app/models/cdoMigrationRun.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import {
  parseCustomerMigrationWorkbook,
  runCustomerMigrationImport,
} from "../app/services/cdo/customerMigration.service.js";

// ── CLI args ───────────────────────────────────────────────────────────────

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const APPLY = process.argv.includes("--apply");
const FILE = arg("file", "docs/migration/Retail_Customer_Migration_FILLED.xlsx");
const CHUNK = Math.max(1, Number(arg("chunk", 25)) || 25);
const PACING_MS = Math.max(0, Number(arg("pacing", 200)) || 0);
const LIMIT = Number(arg("limit", 0)) || 0;
const ONLY_FAILED = arg("only-failed", null);
const RETRY_PASSES = Math.max(0, Number(arg("retry-passes", 1)) || 0);
const LOG_DIR = arg("log-dir", "docs/migration/logs");
const NO_RESUME = process.argv.includes("--no-resume");
const VERIFY_SHOPIFY = process.argv.includes("--verify-shopify");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Retail customer migration — resumable driver

  node --experimental-loader ./scripts/extensionless-loader.mjs \\
       --env-file-if-exists=.env scripts/migrate-retail-customers.js [options]

  --apply                 actually write (default is a dry run)
  --file=<path>           workbook to import        (default ${FILE})
  --chunk=<n>             rows per checkpoint       (default 25)
  --pacing=<ms>           delay between rows        (default 200)
  --limit=<n>             only process the first n outstanding rows
  --only-failed=<csv>     re-run just the emails listed in a failures CSV
  --retry-passes=<n>      extra passes over failed rows (default 1)
  --no-resume             do NOT skip already-linked emails (re-verifies every row)
  --verify-shopify        confirm each already-linked customer still exists in Shopify
                          before trusting it (slower; use after a suspected deletion)
  --log-dir=<path>        where to write logs       (default ${LOG_DIR})
  --help                  this text
`);
  process.exit(0);
}

// ── Shop resolution (same rule as the other CDO scripts) ──────────────────
//
// shopify_sessions is shared with the wholesale workspace's MongoDB, so it can
// hold offline sessions for BOTH shops — findOne() would be a coin flip. Prefer
// the explicit override; only auto-detect when there is exactly one shop.
async function resolveRetailShop() {
  if (process.env.CDO_RETAIL_SHOP) return process.env.CDO_RETAIL_SHOP;
  const sessions = await mongoose.connection.db
    .collection("shopify_sessions")
    .find({ isOnline: false })
    .toArray();
  const shops = [...new Set(sessions.map((s) => s.shop).filter(Boolean))];
  if (shops.length === 0) {
    throw new Error("Could not resolve the retail shop — no offline session in shopify_sessions and CDO_RETAIL_SHOP is not set.");
  }
  if (shops.length > 1) {
    throw new Error(`Ambiguous retail shop (${shops.length}: ${shops.join(", ")}) — shopify_sessions is shared across apps. Set CDO_RETAIL_SHOP in .env.`);
  }
  return shops[0];
}

// ── Small helpers ──────────────────────────────────────────────────────────

const lc = (v) => String(v ?? "").trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const stamp = () => nowIso().replace(/[:.]/g, "-").slice(0, 19);
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s`;
}

// Emails to re-run, read from a previous run's failures CSV.
function readFailedEmails(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = (lines[0] || "").split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const emailIdx = header.findIndex((h) => h === "email");
  if (emailIdx < 0) throw new Error(`${csvPath} has no "email" column — is it a failures CSV?`);
  const out = new Set();
  for (const line of lines.slice(1)) {
    // Good enough for our own output: quoted cells never contain a newline here.
    const cells = line.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) || [];
    const raw = (cells[emailIdx] || "").replace(/^"|"$/g, "").replace(/""/g, '"');
    if (raw) out.add(lc(raw));
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log(`\n=== Retail customer migration — ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"} ===`);

  await connectDB();
  const shop = await resolveRetailShop();
  console.log(`shop: ${shop}`);

  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) throw new Error(`Workbook not found: ${abs}`);
  const parsed = parseCustomerMigrationWorkbook(new Uint8Array(fs.readFileSync(abs)));
  const allRows = parsed.customers || [];
  console.log(`workbook: ${FILE} — ${allRows.length} rows`);

  // ── Resume set, derived from the database ──
  let done = new Set();
  if (!NO_RESUME) {
    const linked = await CdoApplication.find(
      { shop, migrationSource: "retail_customer", customerId: { $ne: null } },
      { email: 1, customerId: 1 },
    ).lean();
    done = new Set(linked.map((d) => lc(d.email)));
    console.log(`already linked in cdo_applications: ${done.size}`);

    if (VERIFY_SHOPIFY) {
      // Only worth it if you suspect customers were deleted in Shopify after
      // being linked — otherwise the DB link is trusted (it stores the gid we
      // got back from Shopify itself).
      const { admin } = await unauthenticated.admin(shop);
      let checked = 0;
      let vanished = 0;
      for (const d of linked) {
        const res = await admin.graphql(
          `#graphql
            query VerifyMigratedCustomer($id: ID!) { customer(id: $id) { id } }`,
          { variables: { id: d.customerId } },
        );
        const json = await res.json();
        if (!json?.data?.customer) {
          done.delete(lc(d.email));
          vanished += 1;
        }
        checked += 1;
        if (checked % 200 === 0) console.log(`  verified ${checked}/${linked.length} (${vanished} vanished)`);
        await new Promise((r) => setTimeout(r, 120));
      }
      console.log(`verify-shopify: ${vanished} linked customers no longer exist — they will be re-created.`);
    }
  }

  // ── Which rows still need work ──
  const onlyFailed = ONLY_FAILED ? readFailedEmails(path.resolve(ONLY_FAILED)) : null;
  if (onlyFailed) console.log(`--only-failed: restricting to ${onlyFailed.size} emails from ${ONLY_FAILED}`);

  // Global de-dupe by email BEFORE chunking. The service de-dupes within one
  // call, and chunking means many calls — without this a repeated email could
  // slip through in two different chunks.
  const seen = new Set();
  const inSheetDupes = [];
  let outstanding = [];
  for (const row of allRows) {
    const email = lc(row.email);
    if (email && seen.has(email)) {
      inSheetDupes.push({ rowId: row.row_id ?? row._sheetRowNumber, email });
      continue;
    }
    if (email) seen.add(email);
    if (done.has(email)) continue;
    if (onlyFailed && !onlyFailed.has(email)) continue;
    outstanding.push(row);
  }
  if (inSheetDupes.length) console.log(`in-sheet duplicate emails skipped: ${inSheetDupes.length}`);
  if (LIMIT && outstanding.length > LIMIT) {
    console.log(`--limit=${LIMIT}: processing ${LIMIT} of ${outstanding.length} outstanding rows`);
    outstanding = outstanding.slice(0, LIMIT);
  }

  console.log(`\n>>> outstanding rows to process: ${outstanding.length}`);
  if (!outstanding.length) {
    console.log("Nothing to do — every row in the workbook is already linked.\n");
    await mongoose.disconnect();
    return;
  }
  const estMs = outstanding.length * (PACING_MS + 700);
  console.log(`    estimated runtime: ~${fmtDuration(estMs)} at ${PACING_MS}ms pacing\n`);

  if (!APPLY) {
    console.log("DRY RUN — validating every outstanding row against Shopify (reads only)…\n");
  }

  // ── Logs ──
  fs.mkdirSync(path.resolve(LOG_DIR), { recursive: true });
  const tag = `${stamp()}${APPLY ? "" : "-dryrun"}`;
  const failCsvPath = path.resolve(LOG_DIR, `retail-customers-failed-${tag}.csv`);
  const eventLogPath = path.resolve(LOG_DIR, `retail-customers-events-${tag}.jsonl`);
  fs.writeFileSync(failCsvPath, "row_id,email,source,pass,failed_at,reason\n");
  const eventLog = fs.createWriteStream(eventLogPath, { flags: "a" });
  const rowByEmail = new Map(outstanding.map((r) => [lc(r.email), r]));
  const appendFailures = (errors, pass) => {
    if (!errors.length) return;
    const lines = errors.map((e) => {
      const row = e.email ? rowByEmail.get(lc(e.email)) : null;
      return [e.row_id, e.email || row?.email || "", row?.source || "", pass, nowIso(), e.message]
        .map(csvCell)
        .join(",");
    });
    fs.appendFileSync(failCsvPath, `${lines.join("\n")}\n`);
  };

  // ── Audit run doc, rewritten after every chunk so progress is never lost ──
  let runDoc = null;
  if (APPLY) {
    runDoc = await CdoMigrationRun.create({
      shop,
      fileName: `${path.basename(FILE)} (CLI)`,
      actor: `cli:${process.env.USER || process.env.USERNAME || "unknown"}`,
      report: { migrationType: "retail_customer", startedAt: nowIso(), via: "scripts/migrate-retail-customers.js" },
    });
    console.log(`audit run: cdo_migration_runs/${runDoc._id}\n`);
  }

  // ── Ctrl-C: stop cleanly at the next chunk boundary ──
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\n\n! interrupt received — finishing the current chunk, flushing logs, then exiting.");
    console.log("! re-run the same command to resume from here.\n");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // ── Totals across chunks and passes ──
  const totals = {
    total: 0,
    created: 0,
    adopted: 0,
    appCreated: 0,
    appUpdated: 0,
    alreadyLinked: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
  };
  const failedRows = [];

  async function runPass(rows, pass) {
    const passStart = Date.now();
    let processed = 0;
    const { admin } = await unauthenticated.admin(shop);

    for (let i = 0; i < rows.length; i += CHUNK) {
      if (stopping) break;
      const chunk = rows.slice(i, i + CHUNK);

      const report = await runCustomerMigrationImport({
        parsed: { customers: chunk },
        admin,
        shop,
        actor: runDoc?.actor || "cli",
        commit: APPLY,
        migrationRunId: runDoc?._id || null,
        pacingMs: PACING_MS,
        onProgress: ({ email, outcome }) => {
          eventLog.write(`${JSON.stringify({ t: nowIso(), pass, email, outcome })}\n`);
        },
      });

      const c = report.customers;
      totals.total += c.total;
      totals.created += c.created;
      totals.adopted += c.adopted;
      totals.appCreated += c.appCreated;
      totals.appUpdated += c.appUpdated;
      totals.alreadyLinked += c.alreadyLinked;
      totals.skipped += c.skipped;
      totals.errors += c.errors.length;
      totals.warnings += c.warnings.length;

      // Attach the email to each error so the CSV is directly re-feedable.
      const errsWithEmail = c.errors.map((e) => {
        const row = chunk.find((r) => String(r.row_id ?? r._sheetRowNumber) === String(e.row_id));
        return { ...e, email: row ? lc(row.email) : "" };
      });
      appendFailures(errsWithEmail, pass);
      for (const e of errsWithEmail) if (e.email) failedRows.push(e.email);

      processed += chunk.length;
      const elapsed = Date.now() - passStart;
      const rate = processed / (elapsed / 1000);
      const remaining = rows.length - processed;
      process.stdout.write(
        `  [pass ${pass}] ${processed}/${rows.length}` +
          ` · created ${totals.created} · adopted ${totals.adopted}` +
          ` · failed ${totals.errors}` +
          ` · ${rate.toFixed(1)} rows/s · ETA ${fmtDuration((remaining / Math.max(rate, 0.01)) * 1000)}\n`,
      );

      // Checkpoint: whatever happens next, the run doc already tells the truth.
      if (runDoc) {
        await CdoMigrationRun.findByIdAndUpdate(runDoc._id, {
          report: {
            migrationType: "retail_customer",
            via: "scripts/migrate-retail-customers.js",
            startedAt: new Date(startedAt).toISOString(),
            updatedAt: nowIso(),
            complete: false,
            pass,
            workbook: path.basename(FILE),
            outstandingAtStart: outstanding.length,
            failuresCsv: path.relative(process.cwd(), failCsvPath),
            customers: { ...totals },
          },
        });
      }
    }
  }

  await runPass(outstanding, 1);

  // ── Retry passes over just the rows that failed ──
  for (let pass = 2; pass <= RETRY_PASSES + 1 && !stopping; pass++) {
    const retryEmails = [...new Set(failedRows)];
    if (!retryEmails.length) break;
    failedRows.length = 0;
    const retryRows = retryEmails.map((e) => rowByEmail.get(e)).filter(Boolean);
    if (!retryRows.length) break;
    console.log(`\n  retry pass ${pass}: ${retryRows.length} previously-failed rows (most are transient throttle/network)\n`);
    totals.errors = 0; // count fresh for this pass; the CSV keeps the full history
    await runPass(retryRows, pass);
  }

  eventLog.end();

  // ── Final state, read back from the database rather than assumed ──
  const linkedNow = await CdoApplication.countDocuments({
    shop,
    migrationSource: "retail_customer",
    customerId: { $ne: null },
  });

  if (runDoc) {
    await CdoMigrationRun.findByIdAndUpdate(runDoc._id, {
      report: {
        migrationType: "retail_customer",
        via: "scripts/migrate-retail-customers.js",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: nowIso(),
        complete: !stopping,
        interrupted: stopping,
        workbook: path.basename(FILE),
        outstandingAtStart: outstanding.length,
        linkedTotalAfter: linkedNow,
        failuresCsv: path.relative(process.cwd(), failCsvPath),
        customers: { ...totals },
      },
    });
  }

  const stillOutstanding = allRows.length - inSheetDupes.length - linkedNow;
  console.log(`\n=== ${stopping ? "INTERRUPTED" : "DONE"} in ${fmtDuration(Date.now() - startedAt)} ===`);
  console.log(`  Shopify customers created : ${totals.created}`);
  console.log(`  Existing customers adopted: ${totals.adopted}`);
  console.log(`  cdo_applications created  : ${totals.appCreated}`);
  console.log(`  cdo_applications updated  : ${totals.appUpdated}`);
  console.log(`  rows failed (final pass)  : ${totals.errors}`);
  console.log(`  warnings                  : ${totals.warnings}`);
  console.log(`\n  linked in DB now          : ${linkedNow} / ${allRows.length - inSheetDupes.length} unique workbook emails`);
  console.log(`  still outstanding         : ${stillOutstanding}`);
  console.log(`\n  failures CSV : ${path.relative(process.cwd(), failCsvPath)}`);
  console.log(`  event log    : ${path.relative(process.cwd(), eventLogPath)}`);
  if (!APPLY) console.log(`\n  DRY RUN — nothing was written. Re-run with --apply.`);
  else if (stillOutstanding > 0) {
    console.log(`\n  ${stillOutstanding} rows remain. Re-run the same command to resume, or target just the failures:`);
    console.log(`    npm run migrate:retail-customers:apply -- --only-failed=${path.relative(process.cwd(), failCsvPath).replace(/\\/g, "/")}`);
  } else console.log(`\n  Every workbook row is migrated. ✓`);
  console.log("");

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\n[migrate-retail-customers] FAILED: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    try {
      await mongoose.disconnect();
    } catch {
      /* already down */
    }
    process.exit(1);
  });
