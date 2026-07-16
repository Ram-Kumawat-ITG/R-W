// Audit trail for PDFfiller → Wholesale Practitioner Registration data
// migrations run via the Admin Import Interface
// (app.practitioner-migration.jsx). One document per commit (dry runs are
// NOT recorded — only real writes). Mirrors ns-retail's cdo_migration_runs
// convention for the GoAffPro importer.

import mongoose from "mongoose";

const practitionerMigrationRunSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    fileName: String,
    actor: String, // admin email
    // Snapshot of the structured report returned by migration.service.js —
    // per-sheet totals/created/skipped/error counts + row-level errors for
    // quick triage. `strict:false` so the report shape can grow without a
    // schema migration.
    report: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { collection: "practitioner_migration_runs", timestamps: true, strict: true },
);

export default mongoose.models.PractitionerMigrationRun ||
  mongoose.model("PractitionerMigrationRun", practitionerMigrationRunSchema);
