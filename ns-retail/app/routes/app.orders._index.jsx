/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { useLoaderData, useNavigate, useNavigation, useRevalidator, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { listCdoOrders } from "../services/cdo/cdo.service";
import { getRetailInvoicePdf } from "../services/retailQbo/retailOrderInvoice.service";
import { ShippingBadge, DeliveryBadge } from "../components/cdo/StatusBadges";
import { formatCurrency, formatDate } from "../utils/format";

const PAGE_SIZE = 25;

const FILTER_KEYS = [
  "orderNumber",
  "customer",
  "practitioner",
  "referralCode",
  "status",
  "financialStatus",
  "commissionStatus",
  "dateFrom",
  "dateTo",
];

// Human-readable label per filter key (matches the form control labels) — used
// to render the active-filter chips.
const FILTER_LABELS = {
  orderNumber: "Order number",
  customer: "Customer",
  practitioner: "Practitioner",
  referralCode: "Referral code",
  status: "Order status",
  financialStatus: "Payment status",
  commissionStatus: "Commission status",
  dateFrom: "From date",
  dateTo: "To date",
};

// For select-backed filters, map the stored value → its display label so a chip
// reads "Payment status: Partially paid" (not "partially_paid"). Text/date
// fields fall back to the raw value.
const OPTION_LABELS = {
  status: {
    pending: "Pending",
    approved: "Approved",
    paid: "Paid",
    cancelled: "Cancelled",
  },
  financialStatus: {
    paid: "Paid",
    pending: "Pending",
    partially_paid: "Partially paid",
    refunded: "Refunded",
    partially_refunded: "Partially refunded",
    voided: "Voided",
  },
  commissionStatus: {
    attributed: "Attributed",
    unattributed: "Unattributed",
  },
};

// Project the active (URL) filters into a full draft shape (every key present,
// defaulting to "").
function pickFilters(filters) {
  const out = {};
  for (const k of FILTER_KEYS) out[k] = filters?.[k] || "";
  return out;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const sp = url.searchParams;

  const filters = {};
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) filters[k] = v;
  }
  const page = Number(sp.get("page")) || 1;
  const sort = sp.get("sort") || "placedAt";
  const dir = sp.get("dir") || "desc";

  const result = await listCdoOrders({ page, pageSize: PAGE_SIZE, sort, dir, filters });
  return { result, filters, sort, dir };
};

// In-app QBO invoice PDF preview (same proxy pattern as the detail page) — the
// admin views the invoice without holding QBO credentials. Returns the PDF
// base64 in a JSON envelope; the browser turns it into a blob URL.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const op = String(form.get("_action") || "");
  const shopifyOrderId = String(form.get("shopifyOrderId") || "");
  if (op !== "invoice-pdf") return { status: "error", message: "Unknown action." };
  if (!shopifyOrderId) return { status: "error", op, message: "Missing order id." };
  const r = await getRetailInvoicePdf({ shop: session.shop, shopifyOrderId });
  if (r.ok) {
    return { status: "success", op, base64: r.base64, contentType: r.contentType, filename: r.filename };
  }
  if (r.reason === "no_invoice") return { status: "error", op, message: "No QBO invoice for this order yet." };
  return { status: "error", op, message: r.error || "Could not load the invoice PDF." };
};

export default function OrdersList() {
  const { result, filters, sort, dir } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const loading = navigation.state === "loading" || revalidator.state !== "idle";
  const refreshLoading = revalidator.state !== "idle";

  const EMPTY_DRAFT = {
    orderNumber: "", customer: "", practitioner: "", referralCode: "",
    status: "", financialStatus: "", commissionStatus: "", dateFrom: "", dateTo: "",
  };

  // Local, editable copy of the active filters. A ref MIRRORS it (updated
  // synchronously in the change handler) so "Apply filters" always reads the
  // freshest values — even when a control commits its value on `blur` (which
  // fires just before the button's click) rather than per keystroke. Polaris
  // s-* controls differ in whether they emit `input` or `change`, so we bind
  // BOTH and read from the ref instead of the (possibly-stale) state closure.
  const [draft, setDraft] = useState(() => ({ ...EMPTY_DRAFT, ...pickFilters(filters) }));
  const draftRef = useRef(draft);

  const set = (k) => (e) => {
    const v = e?.currentTarget?.value ?? "";
    draftRef.current = { ...draftRef.current, [k]: v };
    setDraft((d) => ({ ...d, [k]: v }));
  };
  // Spread onto every control so the value is captured no matter which event
  // the component emits.
  const bind = (k) => ({ value: draft[k], onInput: set(k), onChange: set(k) });

  const goto = (next) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
    }
    navigate(`?${params.toString()}`);
  };

  const applyFilters = () => goto({ ...draftRef.current, sort, dir, page: "1" });

  const resetFilters = () => {
    draftRef.current = { ...EMPTY_DRAFT };
    setDraft({ ...EMPTY_DRAFT });
    navigate("?");
  };

  // Active-filter chips — one per applied (URL) filter, label resolved from the
  // select option map where available. Removing a chip re-navigates with that
  // one filter dropped (the others, sort + dir preserved; page reset to 1).
  const activeChips = FILTER_KEYS.filter((k) => filters?.[k]).map((k) => {
    const v = filters[k];
    const display = OPTION_LABELS[k]?.[v] ?? v;
    return { key: k, text: `${FILTER_LABELS[k] || k}: ${display}` };
  });

  const removeChip = (key) => {
    draftRef.current = { ...draftRef.current, [key]: "" };
    setDraft((d) => ({ ...d, [key]: "" }));
    const next = {};
    for (const k of FILTER_KEYS) {
      if (k !== key && filters?.[k]) next[k] = filters[k];
    }
    goto({ ...next, sort, dir, page: "1" });
  };

  const setSort = (field) => {
    const nextDir = sort === field && dir === "desc" ? "asc" : "desc";
    goto({ ...filters, sort: field, dir: nextDir, page: "1" });
  };

  const setPage = (p) => goto({ ...filters, sort, dir, page: String(p) });

  const sortArrow = (field) => (sort === field ? (dir === "asc" ? " ▲" : " ▼") : "");

  // In-app QBO invoice PDF preview. One fetcher serves the whole list (only one
  // preview opens at a time). The window must be opened synchronously in the
  // click (user gesture) to survive popup blockers; we swap in the blob URL
  // once the base64 returns.
  const pdfFetcher = useFetcher();
  const pdfWindowRef = useRef(null);
  const handledPdfRef = useRef(null);
  const previewingId =
    pdfFetcher.state !== "idle" ? pdfFetcher.formData?.get("shopifyOrderId") : null;

  const onPreviewInvoice = (shopifyOrderId) => {
    pdfWindowRef.current = window.open("about:blank", "_blank");
    pdfFetcher.submit(
      { _action: "invoice-pdf", shopifyOrderId: shopifyOrderId || "" },
      { method: "POST" },
    );
  };

  useEffect(() => {
    if (!pdfFetcher.data || pdfFetcher.state !== "idle") return;
    if (pdfFetcher.data.op !== "invoice-pdf") return;
    if (handledPdfRef.current === pdfFetcher.data) return;
    handledPdfRef.current = pdfFetcher.data;
    const data = pdfFetcher.data;
    if (data.status === "success" && data.base64) {
      const binary = atob(data.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: data.contentType || "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const win = pdfWindowRef.current;
      if (win && !win.closed) {
        win.location.href = blobUrl;
      } else {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = data.filename || "invoice.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      pdfWindowRef.current = null;
    } else if (data.status === "error") {
      const win = pdfWindowRef.current;
      if (win && !win.closed) win.close();
      pdfWindowRef.current = null;
    }
  }, [pdfFetcher.data, pdfFetcher.state]);

  const { rows, total, page, pageCount } = result;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))">
            <s-text-field label="Order number" {...bind("orderNumber")} placeholder="#1001" />
            <s-text-field label="Customer" {...bind("customer")} placeholder="Name or email" />
            <s-text-field label="Practitioner" {...bind("practitioner")} placeholder="Name or email" />
            <s-text-field label="Referral code" {...bind("referralCode")} />
            <s-select label="Order status" {...bind("status")}>
              <s-option value="">Any</s-option>
              <s-option value="pending">Pending</s-option>
              <s-option value="approved">Approved</s-option>
              <s-option value="paid">Paid</s-option>
              <s-option value="cancelled">Cancelled</s-option>
            </s-select>
            <s-select label="Payment status" {...bind("financialStatus")}>
              <s-option value="">Any</s-option>
              <s-option value="paid">Paid</s-option>
              <s-option value="pending">Pending</s-option>
              <s-option value="partially_paid">Partially paid</s-option>
              <s-option value="refunded">Refunded</s-option>
              <s-option value="partially_refunded">Partially refunded</s-option>
              <s-option value="voided">Voided</s-option>
            </s-select>
            <s-select label="Commission status" {...bind("commissionStatus")}>
              <s-option value="">Any</s-option>
              <s-option value="attributed">Attributed</s-option>
              <s-option value="unattributed">Unattributed</s-option>
            </s-select>
            <s-date-field label="From date" {...bind("dateFrom")} />
            <s-date-field label="To date" {...bind("dateTo")} />
          </s-grid>
          <s-stack direction="inline" gap="base" alignItems="center" wrap>
            <s-button variant="primary" onClick={applyFilters} {...(loading ? { loading: true } : {})}>
              Apply filters
            </s-button>
            <s-button variant="tertiary" onClick={resetFilters}>Reset</s-button>
            <s-button
              variant="tertiary"
              icon="refresh"
              onClick={() => revalidator.revalidate()}
              {...(refreshLoading ? { loading: true } : {})}
            >
              Refresh
            </s-button>
            {activeChips.length > 0 && (
              <s-text tone="subdued">
                {activeChips.length} filter{activeChips.length === 1 ? "" : "s"} applied
              </s-text>
            )}
          </s-stack>

          {activeChips.length > 0 && (
            <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
              {activeChips.map((c) => (
                <s-clickable-chip
                  key={c.key}
                  removable
                  accessibilityLabel={`Remove filter ${c.text}`}
                  onClick={() => removeChip(c.key)}
                  onRemove={() => removeChip(c.key)}
                >
                  {c.text}
                </s-clickable-chip>
              ))}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section padding="none">
        <s-box padding="base">
          <s-text tone="subdued">
            {total} order{total === 1 ? "" : "s"} · page {page} of {pageCount}
          </s-text>
        </s-box>
        {rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
              <s-heading>No orders found</s-heading>
              <s-paragraph tone="subdued">No cdo_orders match the current filters.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={loading}>
            <s-table-header-row>
              <s-table-header>
                <s-clickable onClick={() => setSort("placedAt")}>Order{sortArrow("placedAt")}</s-clickable>
              </s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Practitioner</s-table-header>
              <s-table-header>Referral</s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("amount")}>Amount{sortArrow("amount")}</s-clickable>
              </s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("commissionAmount")}>Commission{sortArrow("commissionAmount")}</s-clickable>
              </s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Shipping status</s-table-header>
              <s-table-header>Delivery status</s-table-header>
              <s-table-header>QBO Invoice</s-table-header>
              <s-table-header>Vendor Bills</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="none">
                      <s-text>{o.orderName}</s-text>
                      <s-text tone="subdued">{formatDate(o.placedAt)}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{o.customerName}</s-table-cell>
                  <s-table-cell>{o.practitionerName}</s-table-cell>
                  <s-table-cell>{o.referralCode}</s-table-cell>
                  <s-table-cell>{formatCurrency(o.amount, o.currency)}</s-table-cell>
                  <s-table-cell>{o.attributed ? formatCurrency(o.commissionAmount, o.currency) : "—"}</s-table-cell>
                  <s-table-cell>{o.financialStatus}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-200">
                      {o.shippedAt ? (
                        <s-text tone="subdued">{formatDate(o.shippedAt)}</s-text>
                      ) : null}
                      <ShippingBadge status={o.shippingStatus} />
                      <TrackingLinks tracking={o.tracking} />
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-200">
                      {o.deliveredAt ? (
                        <s-text tone="subdued">{formatDate(o.deliveredAt)}</s-text>
                      ) : null}
                      <DeliveryBadge status={o.deliveryStatus} />
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <QboInvoiceCell
                      qbo={o.qbo}
                      previewing={previewingId === o.shopifyOrderId}
                      onPreview={() => onPreviewInvoice(o.shopifyOrderId)}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    <VendorBillCell qbo={o.qbo} />
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      accessibilityLabel={`View order ${o.orderName}`}
                      onClick={() => navigate(`/app/orders/${o.id}`)}
                    >
                      View
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
            <s-button variant="tertiary" icon="arrow-left" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </s-button>
            <s-text tone="subdued">Page {page} of {pageCount}</s-text>
            <s-button variant="tertiary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
              Next
            </s-button>
          </s-stack>
        </s-box>
      </s-section>
    </s-stack>
  );
}

// Carrier name(s) under the shipping badge — each a clickable link through to
// that carrier's tracking page (trackingUrl), mirroring the Order Details page.
// The tracking ID itself is intentionally not shown. Falls back to "Track" when
// the carrier name is unknown; renders nothing until the order ships.
function TrackingLinks({ tracking }) {
  if (!Array.isArray(tracking) || tracking.length === 0) return null;
  return (
    <s-stack direction="block" gap="none">
      {tracking.map((t, i) =>
        t.url ? (
          <s-link key={i} href={t.url} target="_blank">
            {t.company || "Track"} ↗
          </s-link>
        ) : t.company ? (
          <s-text key={i} tone="subdued">
            {t.company}
          </s-text>
        ) : null,
      )}
    </s-stack>
  );
}

// QBO invoice summary cell: invoice number + status, plus actions to preview
// it in-app and open it in QuickBooks Online.
function QboInvoiceCell({ qbo, onPreview, previewing }) {
  if (!qbo?.invoiceId) return <s-text tone="subdued">—</s-text>;
  const statusMap = {
    created: { tone: "success", label: "Created" },
    shipping_synced: { tone: "success", label: "Synced" },
    creating: { tone: "info", label: "Creating…" },
    error: { tone: "critical", label: "Error" },
  };
  const m = statusMap[qbo.syncStatus] || { tone: "neutral", label: qbo.syncStatus || "—" };
  return (
    <s-stack direction="block" gap="small-200">
      {/* <s-text>{qbo.docNumber ? `#${qbo.docNumber}` : qbo.invoiceId}</s-text> */}
      {/* <s-badge tone={m.tone}>{m.label}</s-badge> */}
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-button variant="tertiary" disabled={previewing} onClick={onPreview}>
          Preview
        </s-button>
        {qbo.invoiceUrl ? (
          <s-link href={qbo.invoiceUrl} target="_blank">
           Open in QBO {qbo.docNumber ? `${qbo.docNumber}` : qbo.invoiceId}  ↗
          </s-link>
        ) : null}
      </s-stack>
    </s-stack>
  );
}

// Vendor-bill (A/P) summary cell: the dropship cost owed to the wholesale
// supplier. Mirrors the QBO Invoice column but for the Bill side — a
// settlement badge (Paid once the wholesale dropship invoice reconciles, else
// Unpaid / Error) plus a deep link into QuickBooks. Vendor bills have no
// customer-facing PDF, so there is no in-app Preview. Renders "—" until a bill
// exists for the order.
function VendorBillCell({ qbo }) {
  if (!qbo?.billId) return <s-text tone="subdued">—</s-text>;
  let badge;
  if (qbo.billPaymentStatus === "paid") {
    badge = <s-badge tone="success">Paid</s-badge>;
  } else if (qbo.billReconcileStatus === "error") {
    badge = <s-badge tone="critical">Reconcile error</s-badge>;
  } else if (qbo.billStatus === "error") {
    badge = <s-badge tone="critical">Error</s-badge>;
  } else if (qbo.billStatus === "created") {
    badge = <s-badge tone="neutral">Unpaid</s-badge>;
  } else {
    badge = <s-badge tone="neutral">{qbo.billStatus || "Pending"}</s-badge>;
  }
  return (
    <s-stack direction="block" gap="small-200">
      {badge}
      {qbo.billUrl ? (
        <s-link href={qbo.billUrl} target="_blank">
          Open in QBO {qbo.billDocNumber ? `${qbo.billDocNumber}` : qbo.billId} ↗
        </s-link>
      ) : null}
    </s-stack>
  );
}
