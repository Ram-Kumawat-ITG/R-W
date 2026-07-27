/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  parseCustomerMigrationWorkbook,
  runCustomerMigrationImport,
} from "../services/cdo/customerMigration.service";
import CdoMigrationRun from "../models/cdoMigrationRun.server";
import connectDB from "../db/mongo.server";
import { formatDateTime } from "../utils/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  await connectDB();
  const runs = await CdoMigrationRun.find({ "report.migrationType": "retail_customer" })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
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
  const { admin, session } = await authenticate.admin(request);
  const shop = session?.shop || null;
  const actor = session?.onlineAccessInfo?.associated_user?.email || shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return { status: "error", message: "No file was uploaded." };
  }

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const parsed = parseCustomerMigrationWorkbook(data);
    const commit = op === "commit";

    // On commit, create the audit run first so its _id stamps every record
    // (migrationRunId), then store the final report. Dry runs write nothing.
    let migrationRunId = null;
    if (commit) {
      await connectDB();
      const run = await CdoMigrationRun.create({
        shop,
        fileName: file.name,
        actor,
        report: { migrationType: "retail_customer" },
      });
      migrationRunId = run._id;
    }

    const report = await runCustomerMigrationImport({ parsed, admin, shop, actor, commit, migrationRunId });

    if (commit && migrationRunId) {
      await CdoMigrationRun.findByIdAndUpdate(migrationRunId, { report });
    }
    return { status: "success", op, report };
  } catch (err) {
    console.error("[customer-migration] action failed:", err?.message || err);
    return { status: "error", op, message: err?.message || "Import failed" };
  }
};

// ── UI ─────────────────────────────────────────────────────────────────────

function IssueTable({ title, tone, rows }) {
  if (!rows?.length) return null;
  return (
    <s-stack direction="block" gap="small-200">
      <s-text tone={tone}>{title}: {rows.length}</s-text>
      <s-table>
        <s-table-header-row>
          <s-table-header>Row</s-table-header>
          <s-table-header>Detail</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.slice(0, 50).map((e, i) => (
            <s-table-row key={i}>
              <s-table-cell>{e.row_id ?? "—"}</s-table-cell>
              <s-table-cell>{e.message}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
      {rows.length > 50 && <s-text tone="subdued">…and {rows.length - 50} more.</s-text>}
    </s-stack>
  );
}

function ReportView({ report }) {
  const c = report.customers || {};
  return (
    <s-stack direction="block" gap="base">
      <s-banner tone={report.dryRun ? "info" : "success"}>
        {report.dryRun
          ? "Dry run only — nothing was written to Shopify or the database. Review below, then Commit Import when ready."
          : "Import committed — the changes below were written."}
      </s-banner>
      <s-box padding="base" background="bg-surface" border-color="border" border-width="base" border-radius="base">
        <s-stack direction="block" gap="small-200">
          <s-text variant="headingSm">Customers</s-text>
          <s-stack direction="inline" gap="large" wrap>
            <s-text tone="subdued">Total rows: {c.total || 0}</s-text>
            <s-text tone="success">{report.dryRun ? "Would create" : "Created"} (Shopify): {c.created || 0}</s-text>
            <s-text>{report.dryRun ? "Would adopt" : "Adopted"} (existing): {c.adopted || 0}</s-text>
            {!report.dryRun && <s-text>App docs created: {c.appCreated || 0}</s-text>}
            {!report.dryRun && <s-text>App docs updated: {c.appUpdated || 0}</s-text>}
            {!report.dryRun && c.alreadyLinked > 0 && <s-text tone="subdued">Already linked: {c.alreadyLinked}</s-text>}
            {c.skipped > 0 && <s-text tone="critical">Skipped (errors): {c.skipped}</s-text>}
            {c.warnings?.length > 0 && <s-text tone="warning">Warnings: {c.warnings.length}</s-text>}
          </s-stack>
          <IssueTable title="Errors (row skipped)" tone="critical" rows={c.errors} />
          <IssueTable title="Warnings (imported, review)" tone="warning" rows={c.warnings} />
        </s-stack>
      </s-box>
    </s-stack>
  );
}

export default function CustomerMigration() {
  const { runs } = useLoaderData();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [validatedFile, setValidatedFile] = useState(null);

  const submitting = fetcher.state !== "idle";
  const report = fetcher.data?.status === "success" ? fetcher.data.report : null;
  const errorMessage = fetcher.data?.status === "error" ? fetcher.data.message : null;
  const hasErrors = report ? (report.customers?.errors?.length || 0) > 0 : false;

  useEffect(() => {
    if (fetcher.data?.status === "success" && fetcher.data.op === "validate" && !hasErrors) {
      setValidatedFile(selectedFile);
    }
  }, [fetcher.data, hasErrors, selectedFile]);

  function submit(op) {
    if (!selectedFile) return;
    const fd = new FormData();
    fd.set("_action", op);
    fd.set("file", selectedFile);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  }

  const canCommit = selectedFile && validatedFile === selectedFile && !submitting;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Retail Customer Migration (Phase 1)">
        <s-stack direction="block" gap="base">
          <s-paragraph tone="subdued">
            Upload the completed Retail_Customer_Migration_Template.xlsx (see
            docs/migration/retail-customer-migration-plan.md). This creates or
            adopts the Shopify customer + the cdo_applications record. Referral /
            CDO attribution is a separate later phase and is NOT imported here.
            Always Validate first (a full dry run — every check + Shopify lookup,
            no writes), then Commit. Re-running the same file is safe: existing
            customers are adopted/updated, not duplicated.
          </s-paragraph>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
          />

          <s-stack direction="inline" gap="base">
            <s-button variant="secondary" disabled={!selectedFile || submitting} onClick={() => submit("validate")}>
              {submitting && fetcher.formData?.get("_action") === "validate" ? "Validating…" : "Validate (dry run)"}
            </s-button>
            <s-button variant="primary" disabled={!canCommit} onClick={() => submit("commit")}>
              {submitting && fetcher.formData?.get("_action") === "commit" ? "Importing…" : "Commit Import"}
            </s-button>
          </s-stack>

          {selectedFile && !canCommit && !submitting && (
            <s-text tone="subdued">
              Commit is disabled until this exact file passes a clean Validate — re-select the file and Validate if you just changed it.
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
          <s-paragraph tone="subdued">No customer migration has been committed yet.</s-paragraph>
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
                    Created: {r.report?.customers?.created || 0} · Adopted: {r.report?.customers?.adopted || 0} · Skipped: {r.report?.customers?.skipped || 0}
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
