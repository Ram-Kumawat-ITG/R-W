import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getUnpaidBatchPreview,
  listAdminOrderBatches,
  getAdminOrderBatchStats,
} from "../services/adminOrderBatch/adminOrderBatch.service";
import { formatAmount } from "../utils/format.utils";

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [preview, history, stats] = await Promise.all([
    getUnpaidBatchPreview({ shop: session.shop }),
    listAdminOrderBatches({ shop: session.shop, page: 1, pageSize: 100 }),
    getAdminOrderBatchStats({ shop: session.shop }),
  ]);

  return {
    preview,
    history,
    stats,
    shop: session.shop,
  };
};

// ── Helper components ─────────────────────────────────────────────────────────

function SummaryCard({ label, value, tone }) {
  return (
    <s-box
      padding="base"
      border-color="border"
      border-width="base"
      border-radius="base"
      min-inline-size="160px"
      flex="1"
    >
      <s-stack direction="block" gap="small-200">
        <s-text tone="subdued">{label}</s-text>
        <s-text variant="headingMd" tone={tone || undefined}>
          {value}
        </s-text>
      </s-stack>
    </s-box>
  );
}

function PaymentStatusBadge({ status }) {
  if (!status) return <s-badge tone="default">Unknown</s-badge>;
  const map = {
    pending: ["warning", "Pending"],
    partially_paid: ["info", "Partially paid"],
    failed: ["critical", "Failed"],
    paid: ["success", "Paid"],
    cancelled: ["default", "Cancelled"],
  };
  const [tone, label] = map[status] || ["default", status];
  return <s-badge tone={tone}>{label}</s-badge>;
}

function VendorBillBadge({ bill }) {
  if (!bill?.billId) return <s-text tone="subdued">—</s-text>;
  if (bill.paymentStatus === "paid")
    return <s-badge tone="success">Bill paid</s-badge>;
  if (bill.syncStatus === "error")
    return <s-badge tone="critical">Bill error</s-badge>;
  return <s-badge tone="warning">Bill unpaid</s-badge>;
}

// ── History helper components ─────────────────────────────────────────────────

function DetailField({ label, value, highlight, subdued }) {
  return (
    <s-box min-inline-size="120px">
      <s-stack direction="block" gap="none">
        <s-text tone="subdued">{label}</s-text>
        <s-text
          variant={highlight ? "headingSm" : undefined}
          tone={subdued ? "subdued" : undefined}
        >
          {value}
        </s-text>
      </s-stack>
    </s-box>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

function BatchHistoryTab({ history, stats }) {
  const { batches, total } = history;
  const currency = "USD";

  const [filterYear, setFilterYear] = useState("");
  const [filterMonth, setFilterMonth] = useState("");

  const yearRef = useRef(null);
  const monthRef = useRef(null);

  // Client-side filter — year and/or month independently.
  const filtered = useMemo(() => {
    const y = filterYear ? parseInt(filterYear, 10) : null;
    const m = filterMonth ? parseInt(filterMonth, 10) : null;
    if (!y && !m) return batches;
    return batches.filter((b) => {
      const d = b.processedAt ? new Date(b.processedAt) : null;
      if (!d) return false;
      if (y && d.getFullYear() !== y) return false;
      if (m && d.getMonth() + 1 !== m) return false;
      return true;
    });
  }, [batches, filterYear, filterMonth]);

  // Aggregate stats for the currently-visible (filtered) period.
  const periodStats = useMemo(() => ({
    count: filtered.length,
    amount: filtered.reduce(
      (s, b) => s + (b.totalBatchAmount || b.totalInvoiceAmount || 0),
      0
    ),
    orders: filtered.reduce((s, b) => s + (b.orderCount || 0), 0),
  }), [filtered]);

  const isFiltered = Boolean(filterYear || filterMonth);

  if (!batches.length) {
    return (
      <s-box padding="large-500">
        <s-stack direction="block" gap="base" alignItems="center">
          <s-heading>No batch payments yet</s-heading>
          <s-paragraph tone="subdued">
            Batch payments you process will appear here with a full audit trail.
          </s-paragraph>
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      {/* ── All-time analytics ── */}
      <s-section heading="Analytics Overview">
        <s-stack direction="inline" gap="base" wrap>
          <SummaryCard
            label="Total batches"
            value={String(stats.totalBatches)}
          />
          <SummaryCard
            label="Total paid (all time)"
            value={formatAmount(stats.totalAmount, currency)}
          />
          <SummaryCard
            label="Total orders processed"
            value={String(stats.totalOrders)}
          />
          <SummaryCard
            label="Completed batches"
            value={String(stats.completedBatches)}
            tone={stats.completedBatches > 0 ? "success" : undefined}
          />
          {stats.totalBatches > 0 && (
            <SummaryCard
              label="Avg. batch size"
              value={formatAmount(
                stats.totalAmount / stats.totalBatches,
                currency
              )}
            />
          )}
        </s-stack>
      </s-section>

      {/* ── Month / Year filter ── */}
      <s-section heading="Filter by Period">
        <s-stack direction="inline" gap="base" alignItems="flex-end" wrap>
          <s-text-field
            label="Year"
            type="number"
            placeholder="e.g. 2026"
            value={filterYear}
            min="2020"
            max="2099"
            ref={yearRef}
            onInput={(e) => setFilterYear(e.target.value)}
            onChange={(e) => setFilterYear(e.target.value)}
          />
          <s-text-field
            label="Month (1 – 12)"
            type="number"
            placeholder="e.g. 6"
            value={filterMonth}
            min="1"
            max="12"
            ref={monthRef}
            onInput={(e) => setFilterMonth(e.target.value)}
            onChange={(e) => setFilterMonth(e.target.value)}
          />
          {isFiltered && (
            <s-button
              variant="tertiary"
              onClick={() => {
                setFilterYear("");
                setFilterMonth("");
                if (yearRef.current) yearRef.current.value = "";
                if (monthRef.current) monthRef.current.value = "";
              }}
            >
              Clear filter
            </s-button>
          )}
        </s-stack>

        {/* Period summary cards when a filter is active */}
        {isFiltered && (
          <s-box padding-block-start="base">
            <s-stack direction="inline" gap="base" wrap>
              <SummaryCard
                label="Batches in period"
                value={String(periodStats.count)}
                tone={periodStats.count > 0 ? "success" : undefined}
              />
              <SummaryCard
                label="Amount paid"
                value={formatAmount(periodStats.amount, currency)}
              />
              <SummaryCard
                label="Orders processed"
                value={String(periodStats.orders)}
              />
            </s-stack>
          </s-box>
        )}
      </s-section>

      {/* ── Batch list ── */}
      <s-text tone="subdued">
        {isFiltered
          ? `${periodStats.count} of ${total} batch payment${total !== 1 ? "s" : ""} shown`
          : `${total} batch payment${total !== 1 ? "s" : ""} recorded`}
      </s-text>

      {filtered.length === 0 && (
        <s-box padding="large-500">
          <s-stack direction="block" gap="base" alignItems="center">
            <s-text>No batch payments found for the selected period.</s-text>
          </s-stack>
        </s-box>
      )}

      {filtered.map((b) => (
        <s-section key={b.batchId} padding="base">
          <s-stack direction="block" gap="small-200">
            {/* Batch header row */}
            <s-stack direction="inline" gap="base" alignItems="center" wrap>
              <s-text variant="headingSm">{b.batchId}</s-text>
              {b.status === "completed" && (
                <s-badge tone="success">Completed</s-badge>
              )}
              {b.status === "partial" && (
                <s-badge tone="warning">Partial</s-badge>
              )}
              {b.status === "failed" && (
                <s-badge tone="critical">Failed</s-badge>
              )}
            </s-stack>

            {/* Key details — horizontal inline row */}
            <s-box
              padding="small-200"
              background="bg-surface-secondary"
              border-radius="base"
            >
              <s-stack direction="inline" gap="large" wrap>
                <DetailField label="Reference" value={b.referenceNumber} />
                <DetailField
                  label="Payment date"
                  value={
                    b.paymentDate
                      ? new Date(b.paymentDate).toLocaleDateString()
                      : "—"
                  }
                />
                <DetailField
                  label="Processed"
                  value={
                    b.processedAt
                      ? new Date(b.processedAt).toLocaleString()
                      : "—"
                  }
                />
                <DetailField
                  label="Processed by"
                  value={b.processedBy || "—"}
                />
                <DetailField
                  label="Batch total"
                  value={formatAmount(
                    b.totalBatchAmount || b.totalInvoiceAmount,
                    currency
                  )}
                  highlight
                />
                <DetailField
                  label="Orders"
                  value={String(b.orderCount)}
                />
                <DetailField
                  label="Vendor bills"
                  value="Auto-reconciled"
                  subdued
                />
              </s-stack>
            </s-box>

            {b.notes && (
              <s-text tone="subdued">Note: {b.notes}</s-text>
            )}

            {/* Per-order breakdown */}
            {b.invoiceDetails?.length > 0 && (
              <s-details summary={`Order details (${b.invoiceDetails.length})`}>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Order</s-table-header>
                    <s-table-header>QBO Invoice</s-table-header>
                    <s-table-header>Invoice amount</s-table-header>
                    <s-table-header>Vendor Bill</s-table-header>
                    <s-table-header>Result</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {b.invoiceDetails.map((d, i) => (
                      <s-table-row key={i}>
                        <s-table-cell>{d.orderName || d.shopifyOrderId}</s-table-cell>
                        <s-table-cell>
                          {d.qboDocNumber
                            ? `#${d.qboDocNumber}`
                            : d.qboInvoiceId
                            ? `ID ${d.qboInvoiceId}`
                            : "—"}
                        </s-table-cell>
                        <s-table-cell>
                          {d.amountDue != null
                            ? formatAmount(d.amountDue, d.currency || "USD")
                            : "—"}
                        </s-table-cell>
                        <s-table-cell>
                          {d.vendorBillAmount != null
                            ? formatAmount(d.vendorBillAmount, d.currency || "USD")
                            : "—"}
                        </s-table-cell>
                        <s-table-cell>
                          {d.markResult === "success" && (
                            <s-badge tone="success">Paid</s-badge>
                          )}
                          {d.markResult === "skipped" && (
                            <s-badge tone="default">Skipped</s-badge>
                          )}
                          {d.markResult === "error" && (
                            <s-stack direction="block" gap="none">
                              <s-badge tone="critical">Error</s-badge>
                              {d.markError && (
                                <s-text tone="critical">{d.markError}</s-text>
                              )}
                            </s-stack>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-details>
            )}

            {/* Errors */}
            {b.errors?.length > 0 && (
              <s-banner tone="warning" title="Some invoices had errors">
                {b.errors.map((e, i) => (
                  <s-text key={i}>{e}</s-text>
                ))}
              </s-banner>
            )}
          </s-stack>
        </s-section>
      ))}
    </s-stack>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminOrderBatchPage() {
  const { preview, history, stats } = useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [activeTab, setActiveTab] = useState("batch");
  // Selection state: Set of invoiceId strings included in the batch.
  const [selected, setSelected] = useState(
    () => new Set(preview.invoices.map((i) => i.invoiceId))
  );
  const [referenceNumber, setReferenceNumber] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => {
    // Default to today in YYYY-MM-DD format.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [notes, setNotes] = useState("");

  const refRef = useRef(null);
  const dateRef = useRef(null);
  const notesRef = useRef(null);

  const submitting = fetcher.state !== "idle";
  const result = fetcher.data;

  // Show toast + reset on successful batch.
  const handledResultRef = useRef(null);
  useEffect(() => {
    if (!result || result === handledResultRef.current) return;
    if (fetcher.state !== "idle") return;
    handledResultRef.current = result;

    if (result.status === "success") {
      const d = result.result;
      shopify?.toast?.show(
        `Batch ${d.batchId} created — ${d.successCount} invoice${d.successCount !== 1 ? "s" : ""} marked paid`,
        { duration: 6000 }
      );
      // Reset form and switch to history tab.
      setReferenceNumber("");
      setNotes("");
      setSelected(new Set());
      setActiveTab("history");
      // Revalidate (React Router auto-revalidates loaders after fetcher actions
      // so the history tab refreshes automatically).
    } else if (result.status === "error") {
      shopify?.toast?.show(result.message || "Failed to create batch", {
        isError: true,
      });
    }
  }, [result, fetcher.state, shopify]);

  const toggleAll = () => {
    if (selected.size === preview.invoices.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(preview.invoices.map((i) => i.invoiceId)));
    }
  };

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Compute summary for selected invoices.
  // Batch total = invoice total only. Vendor bills are auto-reconciled by the
  // ns-retail CRON once invoices are paid — the admin's single payment covers
  // the invoice amounts; vendor bills are shown for information only.
  const selectedInvoices = preview.invoices.filter((i) => selected.has(i.invoiceId));
  const selectedInvoiceTotal = selectedInvoices.reduce(
    (s, i) => s + (i.outstanding ?? 0),
    0
  );
  const selectedTotal = selectedInvoiceTotal;

  const handleSubmit = () => {
    // Read latest values from refs (s-* web components fire onChange/onInput;
    // reading the ref ensures we always have the current value).
    const ref = refRef.current?.value?.trim() ?? referenceNumber.trim();
    const date = dateRef.current?.value ?? paymentDate;
    const note = notesRef.current?.value ?? notes;

    if (!ref) {
      shopify?.toast?.show("Reference number is required", { isError: true });
      return;
    }
    if (!date) {
      shopify?.toast?.show("Payment date is required", { isError: true });
      return;
    }
    if (selected.size === 0) {
      shopify?.toast?.show("Select at least one invoice to include in the batch", {
        isError: true,
      });
      return;
    }

    fetcher.submit(
      JSON.stringify({
        selectedInvoiceIds: Array.from(selected),
        referenceNumber: ref,
        paymentDate: date,
        notes: note,
      }),
      {
        method: "POST",
        action: "/api/admin/admin-order-batch",
        encType: "application/json",
      }
    );
  };

  const currency = preview.invoices[0]?.currency || "USD";

  return (
    <s-page inlineSize="large" heading="Batch Payment — Admin Orders">
      {/* Back link */}
      <s-box paddingBlockEnd="base">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => navigate("/app/admin-orders")}>
          Back to Admin Orders
        </s-button>
      </s-box>

      {/* Tabs */}
      <s-stack direction="inline" gap="none">
        <s-button
          variant={activeTab === "batch" ? "primary" : "tertiary"}
          onClick={() => setActiveTab("batch")}
        >
          Next Batch
        </s-button>
        <s-button
          variant={activeTab === "history" ? "primary" : "tertiary"}
          onClick={() => setActiveTab("history")}
        >
          Payment History ({history.total})
        </s-button>
      </s-stack>

      {/* ── Next Batch tab ────────────────────────────────────────────── */}
      {activeTab === "batch" && (
        <s-stack direction="block" gap="base">
          {/* Intro */}
          <s-section>
            <s-paragraph tone="subdued">
              Review all unpaid Admin Order invoices below. Select the orders to include, enter
              your payment reference, and click{" "}
              <strong>Process Batch Payment</strong>. All selected invoices will be marked paid
              immediately. Vendor bills will be reconciled automatically within the next billing cycle.
            </s-paragraph>
          </s-section>

          {/* Summary analytics */}
          <s-section heading="Batch Summary">
            <s-stack direction="inline" gap="base" wrap>
              <SummaryCard
                label="Unpaid invoices"
                value={String(preview.orderCount)}
              />
              <SummaryCard
                label="Total unpaid amount"
                value={formatAmount(preview.totalInvoiceAmount, currency)}
              />
              <SummaryCard
                label="Invoices in batch"
                value={String(selected.size)}
                tone="success"
              />
              <SummaryCard
                label="Batch total"
                value={formatAmount(selectedTotal, currency)}
                tone="success"
              />
            </s-stack>
          </s-section>

          {preview.invoices.length === 0 ? (
            <s-section>
              <s-box padding="large-500">
                <s-stack direction="block" gap="base" alignItems="center">
                  <s-heading>No unpaid invoices</s-heading>
                  <s-paragraph tone="subdued">
                    All Admin Order invoices are paid. New unpaid invoices will appear here
                    once new drop-ship orders come in.
                  </s-paragraph>
                </s-stack>
              </s-box>
            </s-section>
          ) : (
            <>
              {/* Invoice selection table */}
              <s-section heading="Invoices to Include">
                <s-stack direction="block" gap="small-200">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-button
                      variant="tertiary"
                      onClick={toggleAll}
                    >
                      {selected.size === preview.invoices.length
                        ? "Deselect all"
                        : "Select all"}
                    </s-button>
                    <s-text tone="subdued">
                      {selected.size} of {preview.invoices.length} selected
                    </s-text>
                  </s-stack>

                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Include</s-table-header>
                      <s-table-header>Order</s-table-header>
                      <s-table-header>QBO Invoice</s-table-header>
                      <s-table-header>Invoice status</s-table-header>
                      <s-table-header>Invoice amount</s-table-header>
                      <s-table-header>Vendor Bill</s-table-header>
                      <s-table-header>Last activity</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {preview.invoices.map((inv) => {
                        const isSelected = selected.has(inv.invoiceId);
                        return (
                          <s-table-row key={inv.invoiceId}>
                            <s-table-cell>
                              <s-checkbox
                                checked={isSelected}
                                onChange={() => toggleOne(inv.invoiceId)}
                                accessibilityLabel={`Include order ${inv.orderName}`}
                              />
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <s-text>{inv.orderName}</s-text>
                                {inv.attemptCount > 0 && (
                                  <s-text tone="subdued">
                                    {inv.attemptCount}/{inv.maxAttempts} attempts
                                  </s-text>
                                )}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              {inv.qboDocNumber
                                ? `#${inv.qboDocNumber}`
                                : inv.qboInvoiceId
                                ? `ID ${inv.qboInvoiceId}`
                                : <s-text tone="subdued">—</s-text>}
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <PaymentStatusBadge status={inv.paymentStatus} />
                                {inv.amountPaid > 0 && (
                                  <s-text tone="subdued">
                                    Paid {formatAmount(inv.amountPaid, inv.currency)}
                                  </s-text>
                                )}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <s-text>
                                  {formatAmount(inv.outstanding, inv.currency)}
                                </s-text>
                                {inv.amountDue !== inv.outstanding && (
                                  <s-text tone="subdued">
                                    of {formatAmount(inv.amountDue, inv.currency)}
                                  </s-text>
                                )}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="none">
                                <VendorBillBadge bill={inv.vendorBill} />
                                {inv.vendorBill?.amount != null && (
                                  <s-text tone="subdued">
                                    {formatAmount(inv.vendorBill.amount, inv.currency)}
                                  </s-text>
                                )}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              {inv.latestRemark ? (
                                <s-stack direction="block" gap="none">
                                  <s-text tone="subdued">
                                    {inv.latestRemark.message?.slice(0, 60)}
                                    {inv.latestRemark.message?.length > 60 ? "…" : ""}
                                  </s-text>
                                  {inv.latestRemark.createdAt && (
                                    <s-text tone="subdued">
                                      {new Date(inv.latestRemark.createdAt).toLocaleDateString()}
                                    </s-text>
                                  )}
                                </s-stack>
                              ) : (
                                <s-text tone="subdued">—</s-text>
                              )}
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>

                  {/* Selected totals footer */}
                  {selected.size > 0 && (
                    <s-box padding="base" background="bg-surface-secondary" border-radius="base">
                      <s-stack direction="inline" gap="large" alignItems="center" wrap>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">{selected.size} invoice{selected.size !== 1 ? "s" : ""} selected</s-text>
                          <s-text variant="headingSm">
                            {formatAmount(selectedTotal, currency)}
                          </s-text>
                        </s-stack>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">Payment amount (cheque / EFT)</s-text>
                          <s-text variant="headingMd" tone="success">
                            {formatAmount(selectedTotal, currency)}
                          </s-text>
                        </s-stack>
                        <s-stack direction="block" gap="none">
                          <s-text tone="subdued">Vendor bills</s-text>
                          <s-text tone="subdued">Auto-reconciled after payment</s-text>
                        </s-stack>
                      </s-stack>
                    </s-box>
                  )}
                </s-stack>
              </s-section>

              {/* Order breakdown */}
              {preview.vendorBreakdown.length > 1 && (
                <s-section heading="Order Breakdown">
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>Order</s-table-header>
                      <s-table-header>Invoice amount</s-table-header>
                      <s-table-header>Vendor bill status</s-table-header>
                      <s-table-header>Included in batch</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {preview.vendorBreakdown.map((row) => {
                        const inv = preview.invoices.find(
                          (i) => i.shopifyOrderId === row.shopifyOrderId
                        );
                        const isIncluded = inv ? selected.has(inv.invoiceId) : false;
                        return (
                          <s-table-row key={row.shopifyOrderId}>
                            <s-table-cell>{row.orderName}</s-table-cell>
                            <s-table-cell>
                              {formatAmount(row.invoiceAmount, row.currency || currency)}
                            </s-table-cell>
                            <s-table-cell>
                              {row.vendorBillAmount != null ? (
                                <s-stack direction="block" gap="none">
                                  <VendorBillBadge bill={inv?.vendorBill} />
                                  <s-text tone="subdued">
                                    {formatAmount(row.vendorBillAmount, row.currency || currency)}
                                  </s-text>
                                </s-stack>
                              ) : (
                                <s-text tone="subdued">—</s-text>
                              )}
                            </s-table-cell>
                            <s-table-cell>
                              {isIncluded ? (
                                <s-badge tone="success">Yes</s-badge>
                              ) : (
                                <s-badge tone="default">No</s-badge>
                              )}
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                  <s-text tone="subdued">
                    Vendor bills are reconciled automatically once invoices are marked paid.
                  </s-text>
                </s-section>
              )}

              {/* Payment form */}
              <s-section heading="Payment Details">
                <s-stack direction="block" gap="base">
                  <s-grid columns="repeat(auto-fill, minmax(260px, 1fr))" gap="base">
                    <s-text-field
                      label="Cheque / Reference Number *"
                      placeholder="e.g. CHQ-1042 or EFT-20260625"
                      value={referenceNumber}
                      onInput={(e) => setReferenceNumber(e.target.value)}
                      onChange={(e) => setReferenceNumber(e.target.value)}
                      ref={refRef}
                      disabled={submitting}
                    />
                    <s-date-field
                      label="Payment Date *"
                      value={paymentDate}
                      onInput={(e) => setPaymentDate(e.target.value)}
                      onChange={(e) => setPaymentDate(e.target.value)}
                      ref={dateRef}
                      disabled={submitting}
                    />
                  </s-grid>
                  <s-text-area
                    label="Notes (optional)"
                    placeholder="e.g. Monthly drop-ship payment — June 2026"
                    value={notes}
                    onInput={(e) => setNotes(e.target.value)}
                    onChange={(e) => setNotes(e.target.value)}
                    ref={notesRef}
                    disabled={submitting}
                  />
                </s-stack>
              </s-section>

              {/* Confirmation banner before submit */}
              {selected.size > 0 && referenceNumber.trim() && paymentDate && (
                <s-banner tone="info" title="Ready to process">
                  <s-text>
                    This will mark <strong>{selected.size}</strong> invoice
                    {selected.size !== 1 ? "s" : ""} as paid with reference{" "}
                    <strong>{referenceNumber.trim()}</strong> for a total of{" "}
                    <strong>{formatAmount(selectedInvoiceTotal, currency)}</strong>.
                    {" "}Vendor bills will be reconciled automatically by the billing system.
                  </s-text>
                </s-banner>
              )}

              {/* Fetch result banner */}
              {result?.status === "error" && (
                <s-banner tone="critical" title="Batch payment failed">
                  <s-text>{result.message}</s-text>
                </s-banner>
              )}
              {result?.status === "success" && result.result?.errorCount > 0 && (
                <s-banner tone="warning" title="Batch completed with errors">
                  <s-text>
                    {result.result.successCount} invoice
                    {result.result.successCount !== 1 ? "s" : ""} paid,{" "}
                    {result.result.errorCount} failed. See Payment History for details.
                  </s-text>
                </s-banner>
              )}

              {/* Submit */}
              <s-box>
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button
                    variant="primary"
                    disabled={submitting || selected.size === 0}
                    onClick={handleSubmit}
                    loading={submitting}
                  >
                    {submitting
                      ? "Processing…"
                      : `Process Batch Payment (${selected.size} order${selected.size !== 1 ? "s" : ""})`}
                  </s-button>
                  <s-button
                    variant="tertiary"
                    disabled={submitting}
                    onClick={() => navigate("/app/admin-orders")}
                  >
                    Cancel
                  </s-button>
                </s-stack>
              </s-box>
            </>
          )}
        </s-stack>
      )}

      {/* ── Payment History tab ───────────────────────────────────────── */}
      {activeTab === "history" && (
        <s-stack direction="block" gap="base">
          <BatchHistoryTab history={history} stats={stats} />
        </s-stack>
      )}
    </s-page>
  );
}
