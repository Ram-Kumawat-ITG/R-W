import { useEffect, useRef, useState } from "react";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import Invoice from "../models/invoice.server";
import { RETAIL_CUSTOMER_EMAIL } from "../services/dropship/dropship.config";
import { carrierDisplayName } from "../utils/shipping.constants";
import {
  ProcessingBadge,
  PaymentMethodShortText,
  OrdersTabBar,
} from "../components/admin-ui";
import {
  formatAmount,
  parseDateOnly,
  startOfDay,
} from "../utils/format.utils";
import { PAYMENT_METHOD_SHORT } from "../utils/payment.constants";

const PAGE_SIZE = 15;

// ── Advanced filter model ─────────────────────────────────────────────
//
// The Orders list is driven by a full multi-field filter form (free-text +
// dropdowns + date range + amount range) whose values all combine with AND.
// Every control is backed by a URL search param of the same name, so a
// filtered view is shareable / bookmarkable and survives a refresh.
//
// Filters span two collections:
//   - order-scoped  (orderNumber / customer / status / date / amount) are
//     queried directly on ShopifyOrder.
//   - invoice-scoped (paymentStatus / method / flag) are resolved against the
//     Invoice collection first; the matching invoice _ids then narrow the
//     ShopifyOrder query via `invoiceRef $in`. All invoice-scoped clauses are
//     AND-ed into ONE Invoice query (buildInvoiceQuery) so several can apply
//     at once — the old single-select chip model could only ever express one.
const FILTER_KEYS = [
  "orderNumber",
  "customer",
  "status",
  "paymentStatus",
  "method",
  "flag",
  "amountMin",
  "amountMax",
  "dateFrom",
  "dateTo",
];

// Order processing-status options (ShopifyOrder.processingStatus). Only the
// states a wholesale order can actually surface in are offered — admin_order
// / dropship_invoiced live on the dedicated Admin Orders page and are
// excluded from this list entirely.
const ORDER_STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "scheduled", label: "Scheduled" },
  { value: "invoiced", label: "Invoiced" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

// Invoice payment-status options (Invoice.paymentStatus).
const PAYMENT_STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In progress" },
  { value: "awaiting_settlement", label: "Awaiting settlement" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "paid", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

// Preferred-method options. Filters on the immutable order-time
// `customerPaymentPreference` snapshot (falling back to `paymentMethod` for
// legacy invoices) so the result reflects what the customer chose at order
// time, not the mutable cheque→card override.
const METHOD_OPTIONS = [
  { value: "", label: "Any" },
  { value: "card", label: "Card" },
  { value: "ach", label: "ACH" },
  { value: "check", label: "Cheque" },
];

// Quick invoice flags — composite predicates that don't map to a single
// field. Carries over the old "Overdue / Pending cheque / Failed payments"
// chips into the advanced form.
const FLAG_OPTIONS = [
  { value: "", label: "Any" },
  { value: "overdue", label: "Overdue" },
  { value: "pending_cheque", label: "Pending cheque / ACH" },
  { value: "failed_payments", label: "Failed payments" },
];

// Sort controls.
const SORT_OPTIONS = [
  { value: "receivedAt", label: "Order date" },
  { value: "totalAmount", label: "Amount" },
  { value: "completedAt", label: "Completed date" },
];
const SORT_FIELDS = new Set(SORT_OPTIONS.map((o) => o.value));
const DIR_OPTIONS = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

// value → label maps for the select-backed filters, used to render the
// active-filter summary chips in human-readable form.
const OPTION_LABELS = {
  status: Object.fromEntries(ORDER_STATUS_OPTIONS.map((o) => [o.value, o.label])),
  paymentStatus: Object.fromEntries(
    PAYMENT_STATUS_OPTIONS.map((o) => [o.value, o.label]),
  ),
  method: Object.fromEntries(METHOD_OPTIONS.map((o) => [o.value, o.label])),
  flag: Object.fromEntries(FLAG_OPTIONS.map((o) => [o.value, o.label])),
};
// Short field labels for the active-filter summary chips.
const FILTER_FIELD_LABELS = {
  orderNumber: "Order #",
  customer: "Customer",
  status: "Status",
  paymentStatus: "Payment",
  method: "Method",
  flag: "Flag",
  amountMin: "Min $",
  amountMax: "Max $",
  dateFrom: "From",
  dateTo: "To",
};

// Read the active filter values out of the URL search params. Only keys that
// carry a value are returned, so `Object.keys(filters).length` doubles as the
// "is any filter active?" signal.
function readFilters(sp) {
  const out = {};
  for (const k of FILTER_KEYS) {
    const v = (sp.get(k) || "").trim();
    if (v) out[k] = v;
  }
  return out;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build ONE Invoice query that ANDs together every active invoice-scoped
// filter (paymentStatus / method / flag). Returns null when none apply.
// `now` is the cutoff for the overdue comparison; we prefer the full-datetime
// `dueAt` and fall back to the date-only `qboDueDate` for legacy invoices.
function buildInvoiceQuery(f, shop, now) {
  const clauses = [];

  if (f.paymentStatus) clauses.push({ paymentStatus: f.paymentStatus });

  if (f.method) {
    clauses.push({
      $or: [
        { customerPaymentPreference: f.method },
        { customerPaymentPreference: { $exists: false }, paymentMethod: f.method },
        { customerPaymentPreference: null, paymentMethod: f.method },
      ],
    });
  }

  if (f.flag === "overdue") {
    const todayYmd = ymd(now);
    clauses.push({
      paymentStatus: { $in: ["pending", "failed", "in_progress"] },
      $or: [
        { dueAt: { $lt: now } },
        { dueAt: { $exists: false }, qboDueDate: { $lt: todayYmd, $ne: null } },
        { dueAt: null, qboDueDate: { $lt: todayYmd, $ne: null } },
      ],
    });
  } else if (f.flag === "pending_cheque") {
    clauses.push({
      paymentStatus: { $in: ["pending", "failed"] },
      paymentMethod: { $in: ["check", "ach"] },
    });
  } else if (f.flag === "failed_payments") {
    clauses.push({ paymentStatus: "failed" });
  }

  if (clauses.length === 0) return null;
  return { shop, $and: clauses };
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await connectDB();

  const url = new URL(request.url);
  const sp = url.searchParams;
  const filters = readFilters(sp);
  const page = Math.max(1, Number(sp.get("page") || 1));
  const sort = SORT_FIELDS.has(sp.get("sort")) ? sp.get("sort") : "receivedAt";
  const dir = sp.get("dir") === "asc" ? "asc" : "desc";
  const now = new Date();

  // Exclude Admin Orders (placed by the retail drop-ship customer) from the
  // wholesale Orders list entirely — they live in the dedicated Admin Orders
  // page and never enter the QBO/NMI pipeline. `$ne` still matches orders with
  // a null/absent customerEmail, so ordinary wholesale orders are unaffected.
  const filter = {
    shop: session.shop,
    customerEmail: { $ne: RETAIL_CUSTOMER_EMAIL },
  };
  // Compound order-scoped clauses go into `$and` so they can coexist with the
  // base `customerEmail $ne` (two conditions on the same field) and with each
  // other.
  const and = [];

  if (filters.orderNumber) {
    const re = new RegExp(escapeRegex(filters.orderNumber), "i");
    and.push({
      $or: [
        { shopifyOrderNumber: re },
        { shopifyOrderName: re },
        { shopifyOrderId: filters.orderNumber }, // exact id paste
      ],
    });
  }
  if (filters.customer) {
    and.push({ customerEmail: new RegExp(escapeRegex(filters.customer), "i") });
  }
  if (filters.status) filter.processingStatus = filters.status;

  // Order-date range (receivedAt), inclusive on both ends.
  const dateFrom = parseDateOnly(filters.dateFrom);
  const dateTo = parseDateOnly(filters.dateTo);
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.$gte = startOfDay(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    filter.receivedAt = range;
  }

  // Amount range (totalAmount).
  const amountMin = Number(filters.amountMin);
  const amountMax = Number(filters.amountMax);
  const hasMin = filters.amountMin && Number.isFinite(amountMin);
  const hasMax = filters.amountMax && Number.isFinite(amountMax);
  if (hasMin || hasMax) {
    const range = {};
    if (hasMin) range.$gte = amountMin;
    if (hasMax) range.$lte = amountMax;
    filter.totalAmount = range;
  }

  // Invoice-scoped filters (paymentStatus / method / flag): resolve the
  // matching invoice _ids first, then narrow the order query via invoiceRef.
  // Kept as a separate step (not a $lookup) so the flat pagination query
  // shape is preserved.
  const invoiceQuery = buildInvoiceQuery(filters, session.shop, now);
  if (invoiceQuery) {
    const matched = await Invoice.find(invoiceQuery).select("_id").lean();
    filter.invoiceRef = { $in: matched.map((m) => m._id) };
  }

  if (and.length) filter.$and = and;

  const total = await ShopifyOrder.countDocuments(filter);
  const rows = await ShopifyOrder.find(filter)
    .sort({ [sort]: dir === "asc" ? 1 : -1 })
    .skip((page - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .select(
      "shopifyOrderId shopifyOrderNumber shopifyOrderName customerEmail " +
        "currency totalAmount processingStatus paymentStatus paidAt " +
        "qboInvoiceId invoiceRef receivedAt completedAt processingError rejectionCode " +
        "fulfillmentStatus shippedAt deliveredAt fulfillments",
    )
    .lean();

  // Pull the linked invoices in one query — every payment-related field
  // we render lives on Invoice now, so a single fetch covers attemptCount,
  // QBO due date, the order-time preference snapshot, and the settled-via
  // record. No N+1 and no separate CustomerMap fetch (which would have
  // returned the *current* preference, not the order-time one).
  const invoiceIds = rows.map((r) => r.invoiceRef).filter(Boolean);
  const invoiceById = new Map();
  if (invoiceIds.length) {
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
      .select(
        "paymentStatus paymentMethod customerPaymentPreference paymentSettledVia paymentSettledAt attemptCount maxAttempts lastAttemptError amountDue amountPaid qboDueDate qboTxnDate dueAt remarks",
      )
      .lean();
    for (const inv of invoices) invoiceById.set(inv._id.toString(), inv);
  }

  return {
    rows: rows.map((r) => {
      const inv = r.invoiceRef ? invoiceById.get(r.invoiceRef.toString()) : null;
      return {
        id: r._id.toString(),
        shopifyOrderId: r.shopifyOrderId,
        shopifyOrderNumber: r.shopifyOrderNumber || null,
        shopifyOrderName: r.shopifyOrderName || null,
        customerEmail: r.customerEmail || "",
        currency: r.currency || "USD",
        totalAmount: r.totalAmount ?? null,
        processingStatus: r.processingStatus,
        paymentStatus: r.paymentStatus,
        paidAt: r.paidAt || null,
        qboInvoiceId: r.qboInvoiceId || null,
        receivedAt: r.receivedAt || null,
        completedAt: r.completedAt || null,
        processingError: r.processingError || null,
        rejectionCode: r.rejectionCode || null,
        fulfillmentStatus: r.fulfillmentStatus || null,
        shippedAt: r.shippedAt || null,
        deliveredAt: r.deliveredAt || null,
        // First fulfillment with a tracking URL — used for the Delivery
        // column link. Formatted server-side so shipping.constants stays
        // out of the browser bundle.
        primaryTracking: (() => {
          const f = (r.fulfillments || []).find((f) => f.trackingUrl || f.trackingNumber);
          if (!f) return null;
          return {
            carrier: carrierDisplayName(f.carrierKey, f.trackingCompany),
            trackingUrl: f.trackingUrl || null,
          };
        })(),
        invoice: inv
          ? {
              paymentStatus: inv.paymentStatus,
              paymentMethod: inv.paymentMethod || null,
              paymentSettledVia: inv.paymentSettledVia || null,
              paymentSettledAt: inv.paymentSettledAt || null,
              attemptCount: inv.attemptCount,
              maxAttempts: inv.maxAttempts,
              lastAttemptError: inv.lastAttemptError || null,
              amountDue: inv.amountDue,
              amountPaid: inv.amountPaid,
              qboDueDate: inv.qboDueDate || null,
              qboTxnDate: inv.qboTxnDate || null,
              dueAt: inv.dueAt || null,
              // Most recent remark + total count for the Order List
              // "Remarks" column. Sending only the latest keeps the
              // payload small; admins can open Order Details for the
              // full timeline.
              latestRemark: inv.remarks?.length
                ? inv.remarks[inv.remarks.length - 1]
                : null,
              remarkCount: inv.remarks?.length || 0,
            }
          : null,
        // Immutable preference snapshot from the time this order was
        // placed. Reads ONLY from Invoice.customerPaymentPreference —
        // never `paymentMethod` (which is mutable via cheque → card
        // override) and never CustomerMap (which is the *current*
        // preference, not the historical one). Legacy invoices missing
        // the snapshot are backfilled at boot via
        // backfillCustomerPaymentPreferences in invoice.migrations.js.
        customerPreference: inv?.customerPaymentPreference || null,
      };
    }),
    total,
    page,
    pageSize: PAGE_SIZE,
    filters,
    sort,
    dir,
  };
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shared overdue predicate for the Order List cells. Prefers `dueAt`
// (full datetime; driven by INVOICE_TERMS_MINUTES so admins can flip
// an invoice overdue in minutes during testing) and falls back to the
// QBO date-only `qboDueDate` for older invoices that don't have
// `dueAt` set. Cancelled / paid invoices are never overdue regardless.
function isOverdueByInvoice(invoice, now) {
  if (!invoice) return false;
  if (
    invoice.paymentStatus === "paid" ||
    invoice.paymentStatus === "cancelled"
  ) {
    return false;
  }
  if (invoice.dueAt) {
    const dt = new Date(invoice.dueAt);
    if (Number.isFinite(dt.getTime())) return dt < now;
  }
  const due = parseDateOnly(invoice.qboDueDate);
  if (!due) return false;
  return due < startOfDay(now);
}

export default function OrdersList() {
  const { rows, total, page, pageSize, filters, sort, dir } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const loadedToastShown = useRef(false);

  // One-time toast on first mount.
  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    shopify?.toast?.show(`Loaded ${total} ${total === 1 ? "order" : "orders"}`);
  }, [total, shopify]);

  const tableLoading = navigation.state === "loading" || revalidator.state !== "idle";
  const refreshLoading = revalidator.state !== "idle";
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  // ── Filter form state ───────────────────────────────────────────────
  //
  // `draft` is the local, editable copy of the form. A ref MIRRORS it
  // (updated synchronously in the change handler) so "Apply filters" always
  // reads the freshest values — even for a control that commits its value on
  // `blur`, which fires just before the button's click. Polaris s-* controls
  // vary in whether they emit `input` or `change`, so each control binds BOTH
  // and we read from the ref rather than a possibly-stale state closure.
  const EMPTY_DRAFT = {
    orderNumber: "", customer: "", status: "", paymentStatus: "",
    method: "", flag: "", amountMin: "", amountMax: "", dateFrom: "", dateTo: "",
    sort: "receivedAt", dir: "desc",
  };
  const [draft, setDraft] = useState(() => ({
    ...EMPTY_DRAFT,
    ...filters,
    sort,
    dir,
  }));
  const draftRef = useRef(draft);

  const set = (k) => (e) => {
    const v = e?.currentTarget?.value ?? "";
    draftRef.current = { ...draftRef.current, [k]: v };
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const bind = (k) => ({ value: draft[k], onInput: set(k), onChange: set(k) });

  // Navigate with the given param object — empties are dropped so the URL
  // (and therefore the loader query) only carries the active filters.
  const goto = (next) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v !== "" && v != null) params.set(k, String(v));
    }
    navigate(`?${params.toString()}`);
  };

  const applyFilters = () => goto({ ...draftRef.current, page: "1" });
  const resetFilters = () => {
    draftRef.current = { ...EMPTY_DRAFT };
    setDraft({ ...EMPTY_DRAFT });
    navigate("?");
  };
  const setPage = (p) => goto({ ...filters, sort, dir, page: String(p) });

  // Active-filter summary chips. Each is individually removable; clicking the
  // chip (or its ✕) drops just that one filter and re-queries.
  const activeChips = FILTER_KEYS.filter((k) => filters[k]).map((k) => {
    const raw = filters[k];
    const label = OPTION_LABELS[k]?.[raw] ?? raw;
    return { key: k, text: `${FILTER_FIELD_LABELS[k]}: ${label}` };
  });
  const hasActiveFilter = activeChips.length > 0;

  const removeFilter = (key) => {
    const next = { ...filters, sort, dir, page: "1" };
    delete next[key];
    draftRef.current = { ...draftRef.current, [key]: "" };
    setDraft((d) => ({ ...d, [key]: "" }));
    goto(next);
  };

  return (
    <s-page inlineSize="large" heading="Practitioner Orders">
      <OrdersTabBar active="orders" />

      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          {/* Responsive auto-fill grid: each control gets ≥220px and the row
              re-flows to as many columns as fit, so it reads as a tidy form
              on desktop and stacks to one column on mobile. */}
          <s-grid
            gap="base"
            gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))"
          >
            <s-text-field
              label="Order number"
              placeholder="#1001"
              {...bind("orderNumber")}
            />
            <s-text-field
              label="Customer email"
              placeholder="name@example.com"
              {...bind("customer")}
            />
            <s-select label="Order status" {...bind("status")}>
              {ORDER_STATUS_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select label="Payment status" {...bind("paymentStatus")}>
              {PAYMENT_STATUS_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select label="Preferred method" {...bind("method")}>
              {METHOD_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select label="Quick flag" {...bind("flag")}>
              {FLAG_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              label="Min amount"
              placeholder="0.00"
              {...bind("amountMin")}
            />
            <s-number-field
              label="Max amount"
              placeholder="0.00"
              {...bind("amountMax")}
            />
            <s-date-field label="From date" {...bind("dateFrom")} />
            <s-date-field label="To date" {...bind("dateTo")} />
            <s-select label="Sort by" {...bind("sort")}>
              {SORT_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select label="Direction" {...bind("dir")}>
              {DIR_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
          </s-grid>

          <s-stack direction="inline" gap="base" alignItems="center" wrap>
            <s-button
              variant="primary"
              onClick={applyFilters}
              {...(tableLoading ? { loading: true } : {})}
            >
              Apply filters
            </s-button>
            <s-button variant="tertiary" onClick={resetFilters}>
              Reset
            </s-button>
            <s-button
              variant="tertiary"
              icon="refresh"
              onClick={() => revalidator.revalidate()}
              {...(refreshLoading ? { loading: true } : {})}
            >
              Refresh
            </s-button>
            {hasActiveFilter && (
              <s-text tone="subdued">
                {activeChips.length} filter
                {activeChips.length === 1 ? "" : "s"} applied
              </s-text>
            )}
          </s-stack>

          {/* Active-filter summary — one removable chip per applied filter so
              admins can see exactly what's narrowing the list and drop any
              single one without rebuilding the whole form. */}
          {hasActiveFilter && (
            <s-stack direction="inline" gap="small-200" alignItems="center" wrap>
              {activeChips.map((c) => (
                <s-clickable-chip
                  key={c.key}
                  removable
                  accessibilityLabel={`Remove filter ${c.text}`}
                  onClick={() => removeFilter(c.key)}
                  onRemove={() => removeFilter(c.key)}
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
            {total === 0
              ? "No orders"
              : `Showing ${firstShown}–${lastShown} of ${total} order${
                  total === 1 ? "" : "s"
                }`}
          </s-text>
        </s-box>

        {rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
              <s-text>{hasActiveFilter ? "🔍" : "📭"}</s-text>
              <s-heading>
                {hasActiveFilter ? "No matching orders" : "No orders yet"}
              </s-heading>
              <s-paragraph tone="subdued">
                {hasActiveFilter
                  ? "No orders match the current filters. Try broadening or clearing them."
                  : "Orders received via the Shopify webhook will appear here."}
              </s-paragraph>
              {hasActiveFilter && (
                <s-button onClick={resetFilters}>Clear all filters</s-button>
              )}
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Processing</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>Preferred method</s-table-header>
              <s-table-header>Settled via</s-table-header>
              <s-table-header>Settled at</s-table-header>
              <s-table-header>Due</s-table-header>
              <s-table-header>Shipping status</s-table-header>
              <s-table-header>Delivery status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => {
                const orderLabel =
                  r.shopifyOrderName ||
                  (r.shopifyOrderNumber ? `#${r.shopifyOrderNumber}` : r.shopifyOrderId);
                // Row click navigation was removed (per usability
                // feedback): clicking anywhere on the row used to open
                // the Order Details page, which fired accidentally
                // when admins were trying to interact with chips, the
                // pagination footer, or text inside cells. Navigation
                // is now gated to an explicit "View" button in the
                // Actions column at the row's right edge.
                return (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{orderLabel}</s-text>
                        {r.receivedAt && (
                          <s-text tone="subdued">
                            {new Date(r.receivedAt).toLocaleDateString()}
                          </s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{r.customerEmail || "—"}</s-table-cell>
                    <s-table-cell>
                      <AmountCell order={r} />
                    </s-table-cell>
                    <s-table-cell>
                      <ProcessingBadge
                        status={r.processingStatus}
                        paymentMethod={r.invoice?.paymentMethod}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <PaymentBadge
                        paymentStatus={r.paymentStatus}
                        invoice={r.invoice}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <PaymentMethodShortText method={r.customerPreference} />
                    </s-table-cell>
                    <s-table-cell>
                      <SettledViaCell
                        invoice={r.invoice}
                        preference={r.customerPreference}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <SettledAtCell invoice={r.invoice} />
                    </s-table-cell>
                    <s-table-cell>
                      <DueDateCell invoice={r.invoice} />
                    </s-table-cell>
                    <s-table-cell>
                      <ShippingStatusCell order={r} />
                    </s-table-cell>
                    <s-table-cell>
                      <DeliveryStatusCell order={r} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        accessibilityLabel={`View order ${orderLabel}`}
                        onClick={() => navigate(`/app/orders/${r.id}`)}
                      >
                        View
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {total > 0 && (
          <s-box padding="base">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-text tone="subdued">
                Showing {firstShown}–{lastShown} of {total}
              </s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-button
                  variant="tertiary"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                  icon="arrow-left"
                >
                  Previous
                </s-button>
                <s-text tone="subdued">
                  Page {page} of {totalPages}
                </s-text>
                <s-button
                  variant="tertiary"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </s-button>
              </s-stack>
            </s-stack>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

// Amount cell — shows the fee-inclusive grand total the customer will be
// charged. Prefers Invoice.amountDue (which now bakes in the processing fee
// for card / ACH invoices) over the Shopify order total. When the two differ
// (a fee was added) we surface the pre-fee Shopify total as a subdued
// subtitle so admins can see both at a glance. Falls back to the Shopify
// total for orders with no invoice yet.
function AmountCell({ order }) {
  const shopifyTotal = order.totalAmount;
  const invoiceTotal = order.invoice?.amountDue;
  const currency = order.currency;
  if (invoiceTotal == null) {
    return (
      <s-text>
        {shopifyTotal != null ? formatAmount(shopifyTotal, currency) : "—"}
      </s-text>
    );
  }
  const feeAdded =
    shopifyTotal != null &&
    Number(invoiceTotal).toFixed(2) !== Number(shopifyTotal).toFixed(2);
  return (
    <s-stack direction="block" gap="none">
      <s-text>{formatAmount(invoiceTotal, currency)}</s-text>
      {feeAdded && (
        <s-text tone="subdued">
          incl. fee · {formatAmount(shopifyTotal, currency)} order
        </s-text>
      )}
    </s-stack>
  );
}

// Order-list-specific payment badge — multi-line layout (badge above,
// "attempts" subtitle below). Lives here rather than in admin-ui.jsx
// because the layout is list-specific; the simple PaymentStatusBadge
// shared primitive is used on detail pages.
function PaymentBadge({ paymentStatus, invoice }) {
  if (!invoice) {
    return paymentStatus === "paid" ? (
      <s-badge tone="success">Paid</s-badge>
    ) : (
      <s-text tone="subdued">—</s-text>
    );
  }
  const ps = invoice.paymentStatus;
  if (ps === "paid") return <s-badge tone="success">Paid</s-badge>;
  if (ps === "partially_paid") {
    return (
      <s-stack direction="block" gap="none">
        <s-badge tone="info">Partially paid</s-badge>
        <s-text tone="subdued">{invoice.attemptCount}/{invoice.maxAttempts} attempts</s-text>
      </s-stack>
    );
  }
  if (ps === "cancelled") return <s-badge>Cancelled</s-badge>;
  if (ps === "in_progress") return <s-badge tone="info">In progress</s-badge>;
  if (ps === "failed") {
    return (
      <s-stack direction="block" gap="none">
        <s-badge tone="critical">Failed</s-badge>
        <s-text tone="subdued">{invoice.attemptCount}/{invoice.maxAttempts} attempts</s-text>
      </s-stack>
    );
  }
  // pending
  return (
    <s-stack direction="block" gap="none">
      <s-badge tone="warning">Pending</s-badge>
      <s-text tone="subdued">{invoice.attemptCount}/{invoice.maxAttempts} attempts</s-text>
    </s-stack>
  );
}

// "Settled via" — the actual method that settled the invoice. Reads
// Invoice.paymentSettledVia (set explicitly on each successful payment
// event — NMI approval OR manual cheque). Blank when the invoice
// hasn't been settled yet; "Settled" only means something once payment
// has actually landed. Legacy paid invoices without paymentSettledVia
// fall back to paymentMethod (no override existed before this field,
// so they're equivalent).
function SettledViaCell({ invoice, preference }) {
  if (!invoice || invoice.paymentStatus !== "paid") {
    return <s-text tone="subdued">—</s-text>;
  }
  const method = invoice.paymentSettledVia || invoice.paymentMethod;
  if (!method) return <s-text tone="subdued">—</s-text>;
  const label = PAYMENT_METHOD_SHORT[method] || method;
  const overridden = preference && preference !== method;
  if (overridden) {
    return (
      <s-stack direction="block" gap="none">
        <s-text>{label}</s-text>
        <s-text tone="subdued">override</s-text>
      </s-stack>
    );
  }
  return <s-text>{label}</s-text>;
}

// Timestamp the invoice was settled (paymentSettledAt). Only renders
// for paid invoices — pending/failed/cancelled show "—" to match the
// Settled-via column.
function SettledAtCell({ invoice }) {
  if (
    !invoice ||
    invoice.paymentStatus !== "paid" ||
    !invoice.paymentSettledAt
  ) {
    return <s-text tone="subdued">—</s-text>;
  }
  return <s-text>{new Date(invoice.paymentSettledAt).toLocaleString()}</s-text>;
}

// Fulfillment / shipping status for the Order List — left of the two new
// shipping columns. Shows the Shopify fulfilment state + shipped date.
function ShippingStatusCell({ order }) {
  const { fulfillmentStatus, shippedAt, processingStatus } = order;

  if (processingStatus === "cancelled" && !shippedAt) {
    return <s-text tone="subdued">—</s-text>;
  }

  if (fulfillmentStatus === "fulfilled" || (shippedAt && !fulfillmentStatus)) {
    return (
      <s-stack direction="block" gap="none">
        {shippedAt && (
          <s-text tone="subdued">{new Date(shippedAt).toLocaleDateString()}</s-text>
        )}
        <s-badge tone="success">Fulfilled</s-badge>
      </s-stack>
    );
  }

  if (fulfillmentStatus === "partial") {
    return (
      <s-stack direction="block" gap="none">
        {shippedAt && (
          <s-text tone="subdued">{new Date(shippedAt).toLocaleDateString()}</s-text>
        )}
        <s-badge tone="warning">Partially fulfilled</s-badge>
      </s-stack>
    );
  }

  return <s-badge tone="warning">Unfulfilled</s-badge>;
}

// Carrier delivery status for the Order List — right of the two new shipping
// columns. Shows whether the parcel has been delivered, is in transit, or
// hasn't shipped yet. Delivered date and a tracking deep-link are surfaced
// when available.
function DeliveryStatusCell({ order }) {
  const { deliveredAt, shippedAt, primaryTracking } = order;

  if (deliveredAt) {
    return (
      <s-stack direction="block" gap="none">
        <s-text tone="subdued">{new Date(deliveredAt).toLocaleDateString()}</s-text>
        <s-badge tone="success">Delivered</s-badge>
      </s-stack>
    );
  }

  if (primaryTracking) {
    return (
      <s-stack direction="block" gap="none">
        {shippedAt && (
          <s-text tone="subdued">{new Date(shippedAt).toLocaleDateString()}</s-text>
        )}
        <s-badge tone="info">In transit</s-badge>
        {primaryTracking.trackingUrl ? (
          <s-link url={primaryTracking.trackingUrl} external>
            {primaryTracking.carrier} ↗
          </s-link>
        ) : (
          <s-text tone="subdued">{primaryTracking.carrier}</s-text>
        )}
      </s-stack>
    );
  }

  if (shippedAt) {
    return (
      <s-stack direction="block" gap="none">
        <s-text tone="subdued">{new Date(shippedAt).toLocaleDateString()}</s-text>
        <s-badge tone="info">Shipped</s-badge>
      </s-stack>
    );
  }

  return <s-badge>Not shipped</s-badge>;
}

// Render the QBO due date for an invoice. Highlights overdue + unpaid in
// critical tone so admins can scan the list and spot collections work.
// `qboDueDate` is a "YYYY-MM-DD" string (QBO's date-only format) — see
// the qboDueDate field on the Invoice model.
function DueDateCell({ invoice }) {
  if (!invoice?.qboDueDate) return <s-text tone="subdued">—</s-text>;
  const due = parseDateOnly(invoice.qboDueDate);
  if (!due) return <s-text tone="subdued">{invoice.qboDueDate}</s-text>;
  const isPaid = invoice.paymentStatus === "paid";
  const isCancelled = invoice.paymentStatus === "cancelled";
  // Routes overdue decisions through the shared predicate so the
  // INVOICE_TERMS_MINUTES testing knob shows up here too, not just on
  // the Remarks column.
  const overdue = isOverdueByInvoice(invoice, new Date());
  const settled = isPaid || isCancelled;
  const label = due.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  // Strike through the due date once the invoice is settled (or cancelled)
  // — the date is no longer an active obligation. Uses the semantic
  // <s> element (rendered with browser-default line-through) so we don't
  // need inline styles, which are barred in admin routes.
  return (
    <s-stack direction="block" gap="none">
      <s-text
        tone={overdue ? "critical" : settled ? "subdued" : undefined}
      >
        {settled ? (
          <s>{label}</s>
        ) : overdue ? (
          <strong>{label}</strong>
        ) : (
          label
        )}
      </s-text>
      {overdue && <s-text tone="critical">Overdue</s-text>}
    </s-stack>
  );
}

