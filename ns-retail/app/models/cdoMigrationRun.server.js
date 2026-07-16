// Audit trail for GoAffPro → CDO Program data migrations run via the
// Admin Import Interface (app.cdo-program.migration.jsx). One document per
// commit (dry runs are NOT recorded — only real writes). Mirrors the
// cdo_payout_batches convention of persisting a summary of what an
// operator-triggered run actually did, for traceability.

import mongoose from "mongoose";

const cdoMigrationRunSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    fileName: String,
    actor: String, // admin email
    // Snapshot of the structured report returned by migration.service.js —
    // per-sheet totals/created/skipped/error counts + the first N row-level
    // errors for quick triage. `strict:false` so the report shape can grow
    // without a schema migration.
    report: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { collection: "cdo_migration_runs", timestamps: true, strict: true },
);

export default mongoose.models.CdoMigrationRun ||
  mongoose.model("CdoMigrationRun", cdoMigrationRunSchema);
