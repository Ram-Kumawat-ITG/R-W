/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { parseMigrationWorkbook, runMigrationImport } from "../services/cdo/migration.service";
import CdoMigrationRun from "../models/cdoMigrationRun.server";
import connectDB from "../db/mongo.server";
import { formatDateTime } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();
  const runs = await CdoMigrationRun.find({}).sort({ createdAt: -1 }).limit(10).lean();
  return {
    runs: runs.map((r) => ({
      id: String(r._id),
      fileName: r.fileName,
      actor: r.actor,
      createdAt: r.createdAt,
      report: r.report,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor = session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return { status: "error", message: "No file was uploaded." };
  }

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const parsed = parseMigrationWorkbook(data);
    const commit = op === "commit";
    const report = await runMigrationImport({ parsed, actor, commit });

    if (commit) {
      await connectDB();
      await CdoMigrationRun.create({
        shop: session?.shop || null,
        fileName: file.name,
        actor,
        report,
      });
    }

    return { status: "success", op, report };
  } catch (err) {
    console.error("[cdo-program/migration] action failed:", err?.message || err);
    return { status: "error", op, message: err?.message || "Import failed" };
  }
};

// ── UI ───────────────────────────────────────────────────────────────────

const SECTION_LABELS = {
  practitioners: "Practitioners (matched against wholesale_applications)",
  referralCodes: "Referral Codes",
  referralUrlMapping: "Referral URL Mapping (Shopify redirects)",
  referredCustomers: "Referred Customers",
  historicalOrders: "Historical Orders & Commissions",
  historicalPayouts: "Historical Payouts",
  vendorRates: "Vendor Commission Rates",
};

function ReportSection({ label, section }) {
  if (!section || section.total === 0) return null;
  return (
    <s-box padding="base" background="bg-surface" border-color="border" border-width="base" border-radius="base">
      <s-stack direction="block" gap="small-200">
        <s-text variant="headingSm">{label}</s-text>
        <s-stack direction="inline" gap="large" wrap>
          <s-text tone="subdued">Total: {section.total}</s-text>
          <s-text tone="success">Created/Resolved: {section.created}</s-text>
          {section.updated > 0 && <s-text>Updated: {section.updated}</s-text>}
          {section.alreadyExists > 0 && <s-text tone="subdued">Already existed: {section.alreadyExists}</s-text>}
          {section.skipped > 0 && <s-text tone="subdued">Skipped: {section.skipped}</s-text>}
          {section.errors.length > 0 && <s-text tone="critical">Errors: {section.errors.length}</s-text>}
        </s-stack>
        {section.errors.length > 0 && (
          <s-table>
            <s-table-header-row>
              <s-table-header>Row</s-table-header>
              <s-table-header>Issue</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {section.errors.slice(0, 50).map((e, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{e.row_id ?? "—"}</s-table-cell>
                  <s-table-cell>{e.message}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {section.errors.length > 50 && (
          <s-text tone="subdued">…and {section.errors.length - 50} more.</s-text>
        )}
      </s-stack>
    </s-box>
  );
}

function ReportView({ report }) {
  return (
    <s-stack direction="block" gap="base">
      <s-banner tone={report.dryRun ? "info" : "success"}>
        {report.dryRun
          ? "Dry run only — nothing was written to the database or Shopify. Review the results below, then click Commit Import when ready."
          : "Import committed — the records above were written."}
      </s-banner>
      {Object.entries(SECTION_LABELS).map(([key, label]) => (
        <ReportSection key={key} label={label} section={report[key]} />
      ))}
    </s-stack>
  );
}

export default function CdoMigration() {
  const { runs } = useLoaderData();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  // The exact File object that most recently passed a clean (error-free)
  // dry-run validate. Reference equality against `selectedFile` — picking a
  // new/different file always creates a new File object, so this can never
  // stay stale and let a Commit through against unreviewed data.
  const [validatedFile, setValidatedFile] = useState(null);

  const submitting = fetcher.state !== "idle";
  const report = fetcher.data?.status === "success" ? fetcher.data.report : null;
  const errorMessage = fetcher.data?.status === "error" ? fetcher.data.message : null;

  const hasErrors = report
    ? Object.keys(SECTION_LABELS).some((key) => (report[key]?.errors?.length || 0) > 0)
    : false;

  useEffect(() => {
    if (fetcher.data?.status === "success" && fetcher.data.op === "validate" && !hasErrors) {
      setValidatedFile(selectedFile);
    }
  }, [fetcher.data, hasErrors, selectedFile]);

  function submit(op) {
    if (!selectedFile) return;
    const formData = new FormData();
    formData.set("_action", op);
    formData.set("file", selectedFile);
    fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
  }

  const canCommit = selectedFile && validatedFile === selectedFile && !submitting;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="GoAffPro Migration Import">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="subdued">
            Upload the completed GoAffPro_Migration_Template.xlsx workbook (see
            docs/migration in the repo for the format + full plan). Always run
            Validate first — it performs every check and Shopify lookup without
            writing anything — then Commit Import once the results look right.
            Re-running the same file after a partial commit is safe: already-
            imported rows are detected and skipped, not duplicated.
          </s-paragraph>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
          />

          <s-stack direction="inline" gap="base">
            <s-button
              variant="secondary"
              disabled={!selectedFile || submitting}
              onClick={() => submit("validate")}
            >
              {submitting && fetcher.formData?.get("_action") === "validate" ? "Validating…" : "Validate (dry run)"}
            </s-button>
            <s-button
              variant="primary"
              disabled={!canCommit}
              onClick={() => submit("commit")}
            >
              {submitting && fetcher.formData?.get("_action") === "commit" ? "Importing…" : "Commit Import"}
            </s-button>
          </s-stack>

          {selectedFile && !canCommit && !submitting && (
            <s-text tone="subdued">
              Commit Import is disabled until this exact file passes a clean Validate (dry run) — pick the file again
              and click Validate if you just re-selected it.
            </s-text>
          )}

          {errorMessage && <s-banner tone="critical">{errorMessage}</s-banner>}
        </s-stack>
      </s-section>

      {report && (
        <s-section heading="Import Result">
          <ReportView report={report} />
        </s-section>
      )}

      <s-section heading="Recent Committed Runs">
        {runs.length === 0 ? (
          <s-paragraph tone="subdued">No migration has been committed yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>File</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header>Summary</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {runs.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{r.fileName}</s-table-cell>
                  <s-table-cell>{r.actor}</s-table-cell>
                  <s-table-cell>{formatDateTime(r.createdAt)}</s-table-cell>
                  <s-table-cell>
                    {Object.entries(SECTION_LABELS)
                      .map(([key, label]) => `${label.split(" (")[0]}: ${r.report?.[key]?.created || 0}`)
                      .join(" · ")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-stack>
  );
}
