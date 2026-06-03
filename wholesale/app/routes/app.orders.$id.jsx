import { Fragment, useEffect, useRef, useState } from "react";
import mongoose from "mongoose";
import {
  useLoaderData,
  useNavigate,
  useFetcher,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import ShopifyOrder from "../models/order.server";
import Invoice from "../models/invoice.server";
import PaymentAttempt from "../models/paymentAttempt.server";
import CustomerMap from "../models/customerMap.server";
import { getInvoice as getQboInvoice, getInvoiceWebUrl } from "../services/qbo/qbo.service";
import {
  resolveCustomerVaultId,
  resolveCustomerAchBillingId,
} from "../services/customer/customer.service";
import { invoiceConfig } from "../services/invoice/invoice.config";
import { computeProcessingFee, processingFeeLabel } from "../services/invoice/invoice.utils";
import {
  KV,
  TotalsRow,
  ProcessingBadge,
  PaymentStatusBadge,
  PaymentMethodBadge,
  OutcomeBadge,
} from "../components/admin-ui";
import { formatAmount, fmtDateTime } from "../utils/format.utils";
import { PAYMENT_METHOD_LABEL } from "../utils/payment.constants";

// Statuses for which the manual retry / charge / mark-paid buttons can
// fire. 'paid', 'refunded', 'partially_refunded', 'cancelled', and
// 'in_progress' are excluded — those either have no outstanding balance
// or another action is already mid-flight. 'partially_paid' IS
// included so admins can collect the remainder of a half-paid invoice
// (additional cheque receipt, additional partial card charge, etc).
// Server-side guards in retry-payment.js / charge-card.js /
// mark-cheque-paid.js + the recordManualPayment / chargeInvoice
// service layers all accept partially_paid for the same reason.
const RETRYABLE_PAYMENT_STATUSES = new Set([
  "pending",
  "partially_paid",
  "failed",
]);

// Label + Polaris badge tone for the normalized status returned by the
// last ACH status sync (manual button or CRON). Mirrors the values
// achStatusSync.service writes to Invoice.achSyncLastStatus.
const ACH_SYNC_STATUS_META = {
  settled: { label: "Settled", tone: "success" },
  returned: { label: "Returned", tone: "critical" },
  voided: { label: "Voided", tone: "critical" },
  failed: { label: "Failed", tone: "critical" },
  pending_settlement: { label: "Awaiting settlement", tone: "info" },
  unknown: { label: "Status unknown", tone: "warning" },
  error: { label: "Sync error", tone: "warning" },
};

// Human-readable label + Polaris badge tone for each Invoice.remarks[]
// kind. Keep in lockstep with the enum in models/invoice.server.js so
// the Remarks section never renders an unknown badge.
const REMARK_KIND_META = {
  cron_card_attempt: { label: "CRON charge", tone: "info" },
  cron_ach_attempt: { label: "ACH charge", tone: "info" },
  cron_ach_settlement_check: { label: "ACH settlement", tone: "info" },
  cron_cheque_reminder: { label: "Cheque reminder", tone: "warning" },
  // Legacy kind — preserved for back-compat with rows logged before
  // ACH became an auto-charged method. New rows for ACH go to
  // cron_ach_attempt; this stays in the map so historical rows still
  // render with a sensible badge.
  cron_ach_reminder: { label: "ACH reminder", tone: "warning" },
  cron_failed_followup: { label: "Failed follow-up", tone: "critical" },
  admin_action: { label: "Admin action", tone: "default" },
  system_note: { label: "Note", tone: "default" },
};

// emailEvents[].source enum → friendly label for the Email history table.
// Keep keys aligned with the enum in app/models/invoice.server.js.
const EMAIL_SOURCE_LABEL = {
  invoice_created: "Invoice created",
  payment_recorded: "Payment recorded",
  status_changed: "Status changed",
  manual_resend: "Manual resend",
};

// Status → Polaris badge tone for the pipeline strip at the top of the
// page. "skipped" is rendered same as "pending" tonally; the difference
// is semantic (no longer reachable on this run vs. not reached yet).
const PIPELINE_STEP_TONE = {
  done: "success",
  active: "info",
  pending: "default",
  failed: "critical",
  skipped: "default",
};

// Derive the six pipeline steps from order + invoice state. Pure — no
// side effects, safe to recompute on every render.
function computePipelineSteps({ order, invoice }) {
  const paymentStatus = invoice?.paymentStatus;
  const paid = paymentStatus === "paid";
  const inProgress = paymentStatus === "in_progress";
  const awaitingSettlement = paymentStatus === "awaiting_settlement";
  const failed = paymentStatus === "failed";
  const cancelled = paymentStatus === "cancelled";
  const pending = paymentStatus === "pending";

  const invoiceCreated = !!invoice?.qboInvoiceId;
  const invoiceCreationFailed = invoice?.qboCreationStatus === "failed";
  const orderRejected = order?.processingStatus === "rejected";
  const orderFailed = order?.processingStatus === "failed";
  const completed = order?.processingStatus === "completed";
  const attempts = invoice?.attemptCount ?? 0;
  // Only cheque now sits as "awaiting manual settlement"; ACH is
  // auto-charged in PASS 1 and (when accepted) moves into the
  // awaiting_settlement state which is handled as a distinct
  // sub-status below.
  const isManual = invoice?.paymentMethod === "check";

  // "Payment processing" subtitle is the most context-loaded — it has
  // to convey retries, in-flight charges, manual-wait, ACH settlement
  // limbo, and failures all through one line. Order matters: failed
  // wins over retries.
  let processingSubtitle = null;
  if (failed) {
    processingSubtitle = attempts > 0 ? `Failed after ${attempts}` : "Failed";
  } else if (inProgress) {
    processingSubtitle = "In progress";
  } else if (awaitingSettlement) {
    processingSubtitle = "ACH submitted — awaiting settlement";
  } else if (isManual && pending) {
    processingSubtitle = "Awaiting cheque";
  } else if (attempts > 0 && !paid) {
    processingSubtitle = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  } else if (attempts > 1 && paid) {
    processingSubtitle = `Cleared after ${attempts}`;
  }

  const invoiceStatus = invoiceCreated
    ? "done"
    : invoiceCreationFailed || orderRejected || orderFailed
      ? "failed"
      : invoice
        ? "active"
        : "pending";

  const pendingStepStatus = paid || inProgress || awaitingSettlement
    ? "done"
    : cancelled
      ? "skipped"
      : pending
        ? "active"
        : failed
          ? "failed"
          : "pending";

  const processingStepStatus = paid
    ? "done"
    : inProgress || awaitingSettlement
      ? "active"
      : failed
        ? "failed"
        : isManual && pending
          ? "active"
          : "pending";

  return [
    {
      label: "Order placed",
      status: order ? "done" : "pending",
      subtitle: fmtDateTime(order?.receivedAt),
    },
    {
      label: "Invoice created",
      status: invoiceStatus,
      subtitle: invoice?.qboDocNumber
        ? `#${invoice.qboDocNumber}`
        : orderRejected
          ? order?.rejectionCode || "Rejected"
          : invoiceCreationFailed
            ? "QBO error"
            : null,
    },
    {
      label: "Payment pending",
      status: pendingStepStatus,
      subtitle: invoice?.paymentMethod
        ? PAYMENT_METHOD_LABEL[invoice.paymentMethod] || invoice.paymentMethod
        : null,
    },
    {
      label: "Payment processing",
      status: processingStepStatus,
      subtitle: processingSubtitle,
    },
    {
      label: "Paid",
      status: paid
        ? "done"
        : cancelled
          ? "skipped"
          : failed
            ? "failed"
            : "pending",
      // Only surface paidAt once the step is actually done — defensive
      // against stale fields on partially-migrated rows.
      subtitle: paid ? fmtDateTime(invoice?.paidAt) : null,
    },
    {
      label: "Completed",
      status: completed
        ? "done"
        : orderRejected || orderFailed
          ? "failed"
          : "pending",
      subtitle: completed ? fmtDateTime(order?.completedAt) : null,
    },
  ];
}

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const { id } = params;
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new Response("Invalid id", { status: 400 });
  }

  await connectDB();
  const order = await ShopifyOrder.findOne({ _id: id, shop: session.shop }).lean();
  if (!order) throw new Response("Not found", { status: 404 });

  const invoice = order.invoiceRef
    ? await Invoice.findById(order.invoiceRef).lean()
    : null;

  const attempts = invoice
    ? await PaymentAttempt.find({ invoiceRef: invoice._id })
        .sort({ attemptedAt: -1 })
        .limit(20)
        .lean()
    : [];

  const customerMap = order.customerEmail
    ? await CustomerMap.findOne({ shop: session.shop, email: order.customerEmail })
        .select("qboCustomerId nmiCustomerVaultId nmiAchBillingId profile")
        .lean()
    : null;

  // Cache-or-source-of-truth lookups for BOTH the card vault and the
  // ACH billing id. customer_maps caches are populated at order intake;
  // if the customer captured a card or ACH AFTER that ran, only
  // wholesale_applications has the id. Resolvers check both sides and
  // lazily sync the cache when the source has more, so the page (and
  // the action endpoints) see a consistent view. Card → drives the
  // "Retry payment" + "Charge card on file" buttons; ACH → drives the
  // "Retry ACH payment" button.
  const resolvedVaultId = order.customerEmail
    ? await resolveCustomerVaultId({
        shop: session.shop,
        email: order.customerEmail,
        customerMap,
      })
    : null;
  if (customerMap && resolvedVaultId && !customerMap.nmiCustomerVaultId) {
    customerMap.nmiCustomerVaultId = resolvedVaultId;
  }
  const resolvedAchBillingId = order.customerEmail
    ? await resolveCustomerAchBillingId({
        shop: session.shop,
        email: order.customerEmail,
        customerMap,
      })
    : null;
  if (customerMap && resolvedAchBillingId && !customerMap.nmiAchBillingId) {
    customerMap.nmiAchBillingId = resolvedAchBillingId;
  }

  // Extract line items + totals from the raw Shopify webhook payload so we
  // don't ship the whole blob (addresses, gateway data, etc.) to the client.
  const breakdown = extractBreakdown(order.rawPayload, order.currency);
  // Drop rawPayload from the order snapshot — it's already projected via
  // `breakdown` and would bloat the loader response.
  const orderForClient = serialize(order);
  delete orderForClient.rawPayload;

  // Live-fetch the corresponding QBO invoice when one exists. Graceful
  // degradation: a QBO outage / stale refresh token must NOT 500 the
  // order detail page. We surface the error in a banner instead.
  let qboInvoice = null;
  let qboInvoiceError = null;
  let qboInvoiceUrl = null;
  if (invoice?.qboInvoiceId) {
    qboInvoiceUrl = getInvoiceWebUrl(invoice.qboInvoiceId);
    try {
      const raw = await getQboInvoice(invoice.qboInvoiceId);
      qboInvoice = raw ? projectQboInvoice(raw) : null;
      if (!qboInvoice) qboInvoiceError = "QBO returned no invoice for this id";
    } catch (e) {
      console.error("[orders] QBO invoice fetch failed:", e?.message || e);
      qboInvoiceError = e?.message || "Failed to fetch QBO invoice";
    }
  }

  return {
    order: orderForClient,
    invoice: invoice ? serialize(invoice) : null,
    attempts: attempts.map(serialize),
    customerMap: customerMap ? serialize(customerMap) : null,
    breakdown,
    // Processing-fee rates by settlement method. Surfaced to the client
    // so confirmation modals (charge-card, mark-cheque-paid) can show the
    // fee breakdown + new total before the admin commits. Matches the
    // values that propagateSuccessfulPayment will append to QBO.
    processingFeeRates: { ...invoiceConfig.processingFeeRates },
    qbo: {
      invoice: qboInvoice,
      error: qboInvoiceError,
      url: qboInvoiceUrl,
    },
  };
};

// Pull only the fields we render. QBO invoices include a lot of extra
// payload (custom fields, sales terms, classification refs, etc.) that
// the admin UI doesn't surface today.
function projectQboInvoice(inv) {
  if (!inv) return null;
  const lines = Array.isArray(inv.Line) ? inv.Line : [];
  // QBO returns one "SubTotal" summary line and one per actual item; the
  // SalesItemLineDetail lines are the real product rows.
  const itemLines = lines
    .filter((l) => l.DetailType === "SalesItemLineDetail")
    .map((l) => {
      const detail = l.SalesItemLineDetail || {};
      return {
        id: l.Id || null,
        lineNum: l.LineNum ?? null,
        description: l.Description || null,
        itemName: detail.ItemRef?.name || null,
        itemId: detail.ItemRef?.value || null,
        qty: detail.Qty != null ? Number(detail.Qty) : null,
        unitPrice: detail.UnitPrice != null ? Number(detail.UnitPrice) : null,
        amount: l.Amount != null ? Number(l.Amount) : null,
        serviceDate: detail.ServiceDate || null,
        taxable: !!detail.TaxCodeRef?.value && detail.TaxCodeRef.value !== "NON",
      };
    });

  const linkedPayments = (inv.LinkedTxn || [])
    .filter((t) => t.TxnType === "Payment")
    .map((t) => ({ id: t.TxnId }));

  return {
    id: inv.Id,
    docNumber: inv.DocNumber || null,
    txnDate: inv.TxnDate || null,
    dueDate: inv.DueDate || null,
    customerName: inv.CustomerRef?.name || null,
    customerId: inv.CustomerRef?.value || null,
    billEmail: inv.BillEmail?.Address || null,
    privateNote: inv.PrivateNote || null,
    currency: inv.CurrencyRef?.value || null,
    emailStatus: inv.EmailStatus || null,
    printStatus: inv.PrintStatus || null,
    totalAmt: inv.TotalAmt != null ? Number(inv.TotalAmt) : null,
    balance: inv.Balance != null ? Number(inv.Balance) : null,
    totalTax: inv.TxnTaxDetail?.TotalTax != null
      ? Number(inv.TxnTaxDetail.TotalTax)
      : 0,
    createTime: inv.MetaData?.CreateTime || null,
    lastUpdatedTime: inv.MetaData?.LastUpdatedTime || null,
    lines: itemLines,
    linkedPayments,
  };
}

// Shape what we need from the orders/create webhook payload. Shopify gives
// these as strings; coerce to Number so the UI can format them. Returns
// null for `lineItems`/`totals` when the payload is missing entirely (old
// orders pre-`rawPayload`, or replays where the original was never stored).
function extractBreakdown(rawPayload, fallbackCurrency) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { lineItems: [], totals: null, currency: fallbackCurrency || "USD" };
  }
  const currency = rawPayload.currency || fallbackCurrency || "USD";
  const lineItems = Array.isArray(rawPayload.line_items)
    ? rawPayload.line_items.map((li) => {
        const qty = Number(li.quantity ?? 0);
        const price = Number(li.price ?? 0);
        const discount = Number(li.total_discount ?? 0);
        const lineTotal = Number((price * qty - discount).toFixed(2));
        return {
          id: String(li.id ?? ""),
          name: li.name || li.title || "(unnamed)",
          variantTitle: li.variant_title || null,
          sku: li.sku || null,
          vendor: li.vendor || null,
          quantity: qty,
          unitPrice: price,
          discount,
          lineTotal,
          taxable: li.taxable !== false,
          giftCard: Boolean(li.gift_card),
        };
      })
    : [];

  // Shopify ships shipping costs nested under total_shipping_price_set.
  const shipping = Number(
    rawPayload.total_shipping_price_set?.shop_money?.amount ?? 0,
  );

  const totals = {
    subtotal: Number(rawPayload.subtotal_price ?? rawPayload.total_line_items_price ?? 0),
    discounts: Number(rawPayload.total_discounts ?? 0),
    shipping,
    tax: Number(rawPayload.total_tax ?? 0),
    taxesIncluded: Boolean(rawPayload.taxes_included),
    grandTotal: Number(rawPayload.total_price ?? 0),
  };

  return { lineItems, totals, currency };
}

// Mongoose ObjectIds + Dates need to be stringified before crossing the
// loader boundary. Shallow conversion is fine for our shape.
function serialize(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === "object" && v._bsontype === "ObjectId") {
      out[k] = v.toString();
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  if (out._id && typeof out._id !== "string") out._id = String(out._id);
  return out;
}

export default function OrderDetail() {
  const { order, invoice, attempts, customerMap, breakdown, qbo, processingFeeRates } =
    useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const retryFetcher = useFetcher();
  const chequeFetcher = useFetcher();
  const chargeCardFetcher = useFetcher();
  const pdfFetcher = useFetcher();
  const sendInvoiceFetcher = useFetcher();
  const pauseAutoChargeFetcher = useFetcher();
  const resumeAutoChargeFetcher = useFetcher();
  const pauseRemindersFetcher = useFetcher();
  const resumeRemindersFetcher = useFetcher();
  const syncAchFetcher = useFetcher();
  const modalRef = useRef(null);
  const chequeModalRef = useRef(null);
  const chargeCardModalRef = useRef(null);
  const pauseAutoChargeModalRef = useRef(null);
  const resumeAutoChargeModalRef = useRef(null);
  const pauseRemindersModalRef = useRef(null);
  const resumeRemindersModalRef = useRef(null);
  const [bannerError, setBannerError] = useState(null);
  const [bannerSuccess, setBannerSuccess] = useState(null);
  // Dedicated feedback for the ACH status sync action (its own banner so
  // the wording is accurate — it reflects NMI state, it's not a "retry").
  // Shape: { tone: 'success'|'critical'|'info', heading, text }.
  const [achSyncBanner, setAchSyncBanner] = useState(null);
  const [chequeReference, setChequeReference] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeReceivedAt, setChequeReceivedAt] = useState("");
  const [pauseNote, setPauseNote] = useState("");
  const [resumeNote, setResumeNote] = useState("");
  const [reminderPauseNote, setReminderPauseNote] = useState("");
  const [reminderResumeNote, setReminderResumeNote] = useState("");
  const handledRetryRef = useRef(null);
  const handledChequeRef = useRef(null);
  const handledChargeCardRef = useRef(null);
  const handledPdfRef = useRef(null);
  const handledSendInvoiceRef = useRef(null);
  const handledPauseAutoChargeRef = useRef(null);
  const handledResumeAutoChargeRef = useRef(null);
  const handledPauseRemindersRef = useRef(null);
  const handledResumeRemindersRef = useRef(null);
  const handledSyncAchRef = useRef(null);
  // Holds the window opened synchronously on PDF click; we redirect it
  // to a blob URL once the fetcher returns. Opening *after* the async
  // step would trip popup blockers.
  const pdfWindowRef = useRef(null);

  const orderLabel =
    order.shopifyOrderName ||
    (order.shopifyOrderNumber ? `#${order.shopifyOrderNumber}` : order.shopifyOrderId);

  const retrying =
    retryFetcher.state === "submitting" || retryFetcher.state === "loading";
  const chequeSubmitting =
    chequeFetcher.state === "submitting" || chequeFetcher.state === "loading";
  const chargeCardSubmitting =
    chargeCardFetcher.state === "submitting" ||
    chargeCardFetcher.state === "loading";

  const paymentMethod = invoice?.paymentMethod || "card";
  const isCardInvoice = paymentMethod === "card";
  const isAchInvoice = paymentMethod === "ach";
  // ACH invoices behave like card invoices for auto-charge purposes
  // (the CRON PASS 1 sweep charges both) — but the "Charge card on
  // file" fallback button targets ACH-method invoices too, so it
  // groups under the broader "manual / non-card-method" umbrella for
  // UI gating.
  const isManualInvoice = paymentMethod === "check" || paymentMethod === "ach";
  // "Mark cheque paid" is cheque-specific — ACH invoices auto-charge
  // against the NMI billing id and don't need the manual cheque
  // receipt path. The "Charge card on file" fallback remains visible
  // for both cheque AND ACH (it's the cross-method override).
  const isChequeInvoice = paymentMethod === "check";
  // Immutable preference snapshot taken when this invoice was created.
  // Reads ONLY from customerPaymentPreference — never falls back to
  // paymentMethod (which is mutable via cheque → card override). Legacy
  // invoices missing the snapshot get backfilled at boot from
  // CustomerMap, so this should be set for every real invoice.
  const orderTimePreference = invoice?.customerPaymentPreference || null;

  // Unified payment-history rows for the Invoice & payment section.
  // Merges PaymentAttempt rows where the money actually landed (outcome
  // ∈ {approved, manual_paid}) into a single chronological timeline so
  // the admin sees the full picture in one place — partial cheque +
  // partial card + NMI ACH all together, not split across two boxes.
  //
  // Row shape per entry:
  //   method      — 'check' | 'ach' | 'card' (best-effort; card is the
  //                 default for approved NMI attempts since 99% of NMI
  //                 charges in this app are card)
  //   source      — 'nmi' | 'manual' (drives the reference label)
  //   amount, currency, when (Date), reference, response, by
  const paymentHistoryRows = (() => {
    if (!Array.isArray(attempts) || attempts.length === 0) return [];
    const rows = [];
    for (const a of attempts) {
      if (a.outcome !== "approved" && a.outcome !== "manual_paid") continue;
      const when = a.attemptedAt ? new Date(a.attemptedAt) : null;
      if (a.outcome === "approved") {
        rows.push({
          key: `nmi-${a._id}`,
          source: "nmi",
          method: invoice?.paymentMethod === "ach" ? "ach" : "card",
          amount: a.amount,
          currency: a.currency || invoice?.currency,
          when,
          reference: a.nmiTransactionId || null,
          response: a.nmiResponseText || null,
          authCode: a.nmiAuthCode || null,
          attemptNumber: a.attemptNumber ?? null,
        });
      } else {
        // manual_paid — find the matching manualPayments[] entry by
        // amount + timestamp (within 60s) to recover the cheque/ACH
        // reference and kind. Falls back to parsing the response text
        // ("Manual cheque payment — ref 65") when no match.
        const mp = (invoice?.manualPayments || []).find((m) => {
          if (Number(m.amount).toFixed(2) !== Number(a.amount).toFixed(2)) {
            return false;
          }
          if (!m.recordedAt || !when) return true;
          return Math.abs(new Date(m.recordedAt) - when) < 60_000;
        });
        const textKindMatch = /Manual\s+(cheque|ach)\s+payment/i.exec(
          a.nmiResponseText || "",
        );
        const textRefMatch = /ref\s+([^\s—)]+)/i.exec(a.nmiResponseText || "");
        const rawKind = (mp?.kind || textKindMatch?.[1] || "cheque").toLowerCase();
        rows.push({
          key: `manual-${a._id}`,
          source: "manual",
          // canonical Invoice enum value is 'check'; 'cheque' is the
          // manualPayments display label
          method: rawKind === "ach" ? "ach" : "check",
          amount: a.amount,
          currency: a.currency || mp?.currency || invoice?.currency,
          when: when || (mp?.recordedAt ? new Date(mp.recordedAt) : null),
          reference: mp?.reference || textRefMatch?.[1] || null,
          response: mp?.note || a.nmiResponseText || null,
          authCode: null,
          attemptNumber: a.attemptNumber ?? null,
        });
      }
    }
    rows.sort((x, y) => {
      const tx = x.when ? x.when.getTime() : 0;
      const ty = y.when ? y.when.getTime() : 0;
      return tx - ty;
    });
    return rows;
  })();
  const totalReceived = paymentHistoryRows.reduce(
    (sum, r) => sum + Number(r.amount || 0),
    0,
  );
  // Distinct settlement methods used across the invoice's payment
  // history. Drives the "Settled via" KV when multiple methods
  // contributed (e.g. partial cheque + final card).
  const settledMethods = Array.from(
    new Set(paymentHistoryRows.map((r) => r.method).filter(Boolean)),
  );
  // Method that actually settled the invoice. For paid invoices, prefer
  // the explicit paymentSettledVia; legacy paid invoices fall back to
  // paymentMethod (which is correct since the override hadn't existed).
  // When multiple methods contributed, settledMethods carries the
  // full list — the KV renders all of them so the admin sees the
  // breakdown at a glance.
  const settledVia =
    invoice?.paymentStatus === "paid"
      ? invoice?.paymentSettledVia || invoice?.paymentMethod || null
      : null;
  const pipelineSteps = computePipelineSteps({ order, invoice });
  const statusAllowsAction =
    !!invoice && RETRYABLE_PAYMENT_STATUSES.has(invoice.paymentStatus);

  // "Retry payment" runs the same charge path as the CRON. Every NMI
  // sale needs the customer vault id; ACH invoices ALSO need the ACH
  // billing id (the id of the ACH billing profile inside the vault,
  // stored at wholesale_applications.payment.ach.nmi_billing_id).
  // Cheque invoices can't be retried via this path — they use Mark
  // cheque paid instead.
  const canRetry =
    statusAllowsAction &&
    !!customerMap?.nmiCustomerVaultId &&
    ((isCardInvoice) ||
      (isAchInvoice && !!customerMap?.nmiAchBillingId));
  const canMarkChequePaid = isChequeInvoice && statusAllowsAction;
  // "Charge card on file" is the cross-method fallback: cheque or ACH
  // invoice that needs to be settled by the card on file (e.g. after
  // an ACH decline). Requires a card vault id regardless of the
  // invoice's current paymentMethod.
  const canChargeCard =
    isManualInvoice &&
    statusAllowsAction &&
    !!customerMap?.nmiCustomerVaultId;

  // Auto-charge pause is gated to card-preferred invoices — the CRON
  // PASS 1 sweep only auto-charges card invoices anyway, so a pause
  // flag on a cheque/ACH invoice would be a silent no-op. The check
  // uses `customerPaymentPreference` (immutable order-time snapshot)
  // rather than `paymentMethod` (mutable; flips when admins use the
  // cheque → card fallback) so a cheque-preferred customer whose
  // invoice was overridden to card still doesn't see the pause UI —
  // their preference hasn't changed.
  const isCardPreferredInvoice = orderTimePreference === "card";
  const autoChargePaused = invoice?.autoChargePaused === true;
  // Settled / cancelled invoices have nothing to pause; show neither
  // button. While in flight ('in_progress' lock held by chargeInvoice)
  // we also hide both — the action wouldn't be safe to apply mid-NMI.
  const pauseActionable =
    !!invoice &&
    isCardPreferredInvoice &&
    invoice.paymentStatus !== "paid" &&
    invoice.paymentStatus !== "cancelled" &&
    invoice.paymentStatus !== "in_progress";
  const canPauseAutoCharge = pauseActionable && !autoChargePaused;
  const canResumeAutoCharge = pauseActionable && autoChargePaused;

  const pauseAutoChargeSubmitting =
    pauseAutoChargeFetcher.state === "submitting" ||
    pauseAutoChargeFetcher.state === "loading";
  const resumeAutoChargeSubmitting =
    resumeAutoChargeFetcher.state === "submitting" ||
    resumeAutoChargeFetcher.state === "loading";

  // Email-reminder pause/resume. Gated to cheque invoices — the reminder
  // CRON only emails Check-method invoices, so a pause flag on a card/ACH
  // invoice would be a silent no-op. Paid/cancelled invoices already drop
  // out of the reminder sweep, so neither button is offered there.
  const reminderPaused = invoice?.reminderPaused === true;
  const reminderPauseActionable =
    !!invoice &&
    isChequeInvoice &&
    invoice.paymentStatus !== "paid" &&
    invoice.paymentStatus !== "cancelled";
  const canPauseReminders = reminderPauseActionable && !reminderPaused;
  const canResumeReminders = reminderPauseActionable && reminderPaused;
  const pauseRemindersSubmitting =
    pauseRemindersFetcher.state === "submitting" ||
    pauseRemindersFetcher.state === "loading";
  const resumeRemindersSubmitting =
    resumeRemindersFetcher.state === "submitting" ||
    resumeRemindersFetcher.state === "loading";

  // "Sync ACH status" — on-demand reconciliation against NMI for an ACH
  // invoice that's awaiting settlement. Only meaningful while there's an
  // in-flight transaction to poll (paymentStatus 'awaiting_settlement'
  // with a pendingSettlementTxnId) — the exact set the CRON sweeps.
  const syncingAch =
    syncAchFetcher.state === "submitting" || syncAchFetcher.state === "loading";
  const isAchAwaitingSettlement =
    isAchInvoice &&
    invoice?.paymentStatus === "awaiting_settlement" &&
    !!invoice?.pendingSettlementTxnId;
  // Disable while a sync is in flight from THIS tab (fetcher submitting) or
  // already running server-side (achSyncInProgress, e.g. another tab / a
  // concurrent CRON tick) — the server also enforces this with an atomic
  // lock, this just reflects it in the UI.
  const canSyncAch =
    isAchAwaitingSettlement &&
    !syncingAch &&
    invoice?.achSyncInProgress !== true;

  // Surface retry result via banner + toast. Don't auto-revalidate manually —
  // React Router 7 does that after the fetcher action settles.
  useEffect(() => {
    if (!retryFetcher.data) return;
    if (retryFetcher.state !== "idle") return;
    if (handledRetryRef.current === retryFetcher.data) return;
    handledRetryRef.current = retryFetcher.data;

    const data = retryFetcher.data;
    if (data.status === "success") {
      const outcome = data.result?.outcome;
      if (outcome === "approved") {
        setBannerSuccess(
          `Charge approved — transaction ${data.result?.transactionId || "(no id)"}`,
        );
        shopify?.toast?.show("Payment retried — approved");
      } else if (outcome === "declined") {
        setBannerError(
          `Declined: ${data.result?.responseText || "(no detail)"}`,
        );
        shopify?.toast?.show("Payment retried — declined", { isError: true });
      } else if (outcome === "error") {
        setBannerError(`NMI error: ${data.result?.responseText || data.message}`);
        shopify?.toast?.show("Payment retried — error", { isError: true });
      } else if (data.result?.skipped) {
        setBannerError(`Skipped: ${data.result.reason}`);
      } else {
        setBannerSuccess(data.message || "Retry submitted");
      }
    } else if (data.status === "error") {
      setBannerError(data.message || "Retry failed");
      shopify?.toast?.show(data.message || "Retry failed", { isError: true });
    }
  }, [retryFetcher.data, retryFetcher.state, shopify]);

  const onConfirmRetry = () => {
    setBannerError(null);
    setBannerSuccess(null);
    modalRef.current?.hideOverlay?.();
    retryFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/retry-payment`,
    });
  };

  const onConfirmCheque = () => {
    setBannerError(null);
    setBannerSuccess(null);
    const ref = chequeReference.trim();
    if (!ref) {
      setBannerError("Cheque reference is required");
      return;
    }
    const body = { reference: ref, kind: paymentMethod === "ach" ? "ach" : "cheque" };
    if (chequeAmount && Number(chequeAmount) > 0) body.amount = Number(chequeAmount);
    if (chequeReceivedAt) body.receivedAt = new Date(chequeReceivedAt).toISOString();
    chequeModalRef.current?.hideOverlay?.();
    chequeFetcher.submit(body, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/mark-cheque-paid`,
      encType: "application/json",
    });
  };

  const onConfirmChargeCard = () => {
    setBannerError(null);
    setBannerSuccess(null);
    chargeCardModalRef.current?.hideOverlay?.();
    chargeCardFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/charge-card`,
    });
  };

  // Fire an on-demand ACH status sync. No confirmation modal — it only
  // reflects what NMI already decided (it never initiates a new charge),
  // and duplicate clicks are blocked by the disabled state + the server
  // lock. React Router auto-revalidates the loader after the action, so
  // the on-page status / badges / last-sync timestamp refresh themselves.
  const onSyncAch = () => {
    setAchSyncBanner(null);
    syncAchFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/sync-ach-status`,
    });
  };

  useEffect(() => {
    if (!syncAchFetcher.data) return;
    if (syncAchFetcher.state !== "idle") return;
    if (handledSyncAchRef.current === syncAchFetcher.data) return;
    handledSyncAchRef.current = syncAchFetcher.data;

    const data = syncAchFetcher.data;
    if (data.status === "success") {
      const act = data.result?.action;
      if (act === "settled") {
        setAchSyncBanner({ tone: "success", heading: "ACH settled", text: data.message });
        shopify?.toast?.show("ACH settlement confirmed");
      } else if (act === "returned") {
        setAchSyncBanner({ tone: "critical", heading: "ACH returned", text: data.message });
        shopify?.toast?.show("ACH returned", { isError: true });
      } else {
        setAchSyncBanner({ tone: "info", heading: "ACH status synced", text: data.message });
        shopify?.toast?.show("ACH status synced");
      }
    } else if (data.status === "error") {
      setAchSyncBanner({
        tone: "critical",
        heading: "Sync did not complete",
        text: data.message || "ACH status sync failed",
      });
      shopify?.toast?.show(data.message || "Sync failed", { isError: true });
    }
  }, [syncAchFetcher.data, syncAchFetcher.state, shopify]);

  useEffect(() => {
    if (!chequeFetcher.data) return;
    if (chequeFetcher.state !== "idle") return;
    if (handledChequeRef.current === chequeFetcher.data) return;
    handledChequeRef.current = chequeFetcher.data;

    const data = chequeFetcher.data;
    if (data.status === "success") {
      const r = data.result || {};
      const partial = r.paymentStatus !== "paid";
      const syncIssues = Array.isArray(r.syncErrors) && r.syncErrors.length > 0;
      let msg = partial
        ? `Cheque recorded — partial payment, $${r.amountPaid?.toFixed?.(2) ?? r.amountPaid} of $${r.amountDue?.toFixed?.(2) ?? r.amountDue}`
        : `Cheque recorded — invoice marked paid`;
      if (syncIssues) {
        msg += ` (sync warnings: ${r.syncErrors.join("; ")})`;
      }
      setBannerSuccess(msg);
      setChequeReference("");
      setChequeAmount("");
      setChequeReceivedAt("");
      shopify?.toast?.show("Cheque recorded");
    } else {
      setBannerError(data.message || "Could not record cheque");
      shopify?.toast?.show(data.message || "Cheque record failed", { isError: true });
    }
  }, [chequeFetcher.data, chequeFetcher.state, shopify]);

  useEffect(() => {
    if (!chargeCardFetcher.data) return;
    if (chargeCardFetcher.state !== "idle") return;
    if (handledChargeCardRef.current === chargeCardFetcher.data) return;
    handledChargeCardRef.current = chargeCardFetcher.data;

    const data = chargeCardFetcher.data;
    if (data.status === "success") {
      const outcome = data.result?.outcome;
      const note =
        data.result?.originalMethod && data.result.originalMethod !== "card"
          ? ` (method flipped ${data.result.originalMethod} → card)`
          : "";
      if (outcome === "approved") {
        setBannerSuccess(
          `Card charge approved — transaction ${data.result?.transactionId || "(no id)"}${note}`,
        );
        shopify?.toast?.show("Card charged — approved");
      } else if (outcome === "declined") {
        setBannerError(
          `Declined: ${data.result?.responseText || "(no detail)"}${note}`,
        );
        shopify?.toast?.show("Card declined", { isError: true });
      } else if (outcome === "error") {
        setBannerError(
          `NMI error: ${data.result?.responseText || data.message}${note}`,
        );
        shopify?.toast?.show("Card charge errored", { isError: true });
      } else if (data.result?.skipped) {
        setBannerError(`Skipped: ${data.result.reason}${note}`);
      } else {
        setBannerSuccess(data.message || "Charge submitted");
      }
    } else {
      setBannerError(data.message || "Could not charge card");
      shopify?.toast?.show(data.message || "Charge failed", { isError: true });
    }
  }, [chargeCardFetcher.data, chargeCardFetcher.state, shopify]);

  // Auto-charge pause/resume submission handlers. Both endpoints
  // accept an optional `note` body for the remarks ledger. Loader
  // auto-revalidates after the action settles so the on-page status
  // display + button reflect the new state without manual refresh.
  const onConfirmPauseAutoCharge = () => {
    setBannerError(null);
    setBannerSuccess(null);
    pauseAutoChargeModalRef.current?.hideOverlay?.();
    const body = {};
    const trimmed = pauseNote.trim();
    if (trimmed) body.note = trimmed;
    pauseAutoChargeFetcher.submit(body, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/pause-auto-charge`,
      encType: "application/json",
    });
  };

  const onConfirmResumeAutoCharge = () => {
    setBannerError(null);
    setBannerSuccess(null);
    resumeAutoChargeModalRef.current?.hideOverlay?.();
    const body = {};
    const trimmed = resumeNote.trim();
    if (trimmed) body.note = trimmed;
    resumeAutoChargeFetcher.submit(body, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/resume-auto-charge`,
      encType: "application/json",
    });
  };

  // Pause result → banner + toast. Same handled-ref idempotency
  // pattern as the other fetchers (React Router auto-revalidates after
  // an action, which can replay this effect).
  useEffect(() => {
    if (!pauseAutoChargeFetcher.data) return;
    if (pauseAutoChargeFetcher.state !== "idle") return;
    if (handledPauseAutoChargeRef.current === pauseAutoChargeFetcher.data) return;
    handledPauseAutoChargeRef.current = pauseAutoChargeFetcher.data;

    const data = pauseAutoChargeFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(
        data.result?.reapplied
          ? "Auto-charge pause refreshed"
          : "Auto-charge paused — CRON will skip this invoice",
      );
      setPauseNote("");
      shopify?.toast?.show("Auto-charge paused");
    } else {
      setBannerError(data.message || "Could not pause auto-charge");
      shopify?.toast?.show(data.message || "Pause failed", { isError: true });
    }
  }, [pauseAutoChargeFetcher.data, pauseAutoChargeFetcher.state, shopify]);

  useEffect(() => {
    if (!resumeAutoChargeFetcher.data) return;
    if (resumeAutoChargeFetcher.state !== "idle") return;
    if (handledResumeAutoChargeRef.current === resumeAutoChargeFetcher.data) return;
    handledResumeAutoChargeRef.current = resumeAutoChargeFetcher.data;

    const data = resumeAutoChargeFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(
        data.result?.wasAlreadyRunning
          ? "Auto-charge was already running — confirmation recorded"
          : "Auto-charge resumed — CRON will charge on the next tick",
      );
      setResumeNote("");
      shopify?.toast?.show("Auto-charge resumed");
    } else {
      setBannerError(data.message || "Could not resume auto-charge");
      shopify?.toast?.show(data.message || "Resume failed", { isError: true });
    }
  }, [resumeAutoChargeFetcher.data, resumeAutoChargeFetcher.state, shopify]);

  // Email-reminder pause/resume submission handlers. Both endpoints
  // accept an optional `note` body for the remarks ledger; loader
  // auto-revalidates after the action settles.
  const onConfirmPauseReminders = () => {
    setBannerError(null);
    setBannerSuccess(null);
    pauseRemindersModalRef.current?.hideOverlay?.();
    const body = {};
    const trimmed = reminderPauseNote.trim();
    if (trimmed) body.note = trimmed;
    pauseRemindersFetcher.submit(body, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/pause-reminders`,
      encType: "application/json",
    });
  };

  const onConfirmResumeReminders = () => {
    setBannerError(null);
    setBannerSuccess(null);
    resumeRemindersModalRef.current?.hideOverlay?.();
    const body = {};
    const trimmed = reminderResumeNote.trim();
    if (trimmed) body.note = trimmed;
    resumeRemindersFetcher.submit(body, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/resume-reminders`,
      encType: "application/json",
    });
  };

  useEffect(() => {
    if (!pauseRemindersFetcher.data) return;
    if (pauseRemindersFetcher.state !== "idle") return;
    if (handledPauseRemindersRef.current === pauseRemindersFetcher.data) return;
    handledPauseRemindersRef.current = pauseRemindersFetcher.data;

    const data = pauseRemindersFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(
        data.result?.reapplied
          ? "Email reminders pause refreshed"
          : "Email reminders paused — CRON will skip this invoice",
      );
      setReminderPauseNote("");
      shopify?.toast?.show("Email reminders paused");
    } else {
      setBannerError(data.message || "Could not pause email reminders");
      shopify?.toast?.show(data.message || "Pause failed", { isError: true });
    }
  }, [pauseRemindersFetcher.data, pauseRemindersFetcher.state, shopify]);

  useEffect(() => {
    if (!resumeRemindersFetcher.data) return;
    if (resumeRemindersFetcher.state !== "idle") return;
    if (handledResumeRemindersRef.current === resumeRemindersFetcher.data) return;
    handledResumeRemindersRef.current = resumeRemindersFetcher.data;

    const data = resumeRemindersFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(
        data.result?.wasAlreadyRunning
          ? "Email reminders were already running — confirmation recorded"
          : "Email reminders resumed — CRON will evaluate the ladder on the next run",
      );
      setReminderResumeNote("");
      shopify?.toast?.show("Email reminders resumed");
    } else {
      setBannerError(data.message || "Could not resume email reminders");
      shopify?.toast?.show(data.message || "Resume failed", { isError: true });
    }
  }, [resumeRemindersFetcher.data, resumeRemindersFetcher.state, shopify]);

  // Click handler must open the new window *synchronously* — that's the
  // only way it counts as a user-gesture and survives popup blockers.
  // We open with "about:blank", then redirect to a blob URL once the
  // server returns the base64 PDF.
  const onViewPdf = () => {
    setBannerError(null);
    pdfWindowRef.current = window.open("about:blank", "_blank");
    pdfFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/qbo-invoice-pdf`,
    });
  };

  // Resolve the PDF fetcher → blob URL → load into the placeholder
  // window. Same handled-ref pattern as the retry effect: React Router
  // auto-revalidates loaders after a fetcher action, which can re-fire
  // this effect; we use a ref to skip the second run.
  useEffect(() => {
    if (!pdfFetcher.data) return;
    if (pdfFetcher.state !== "idle") return;
    if (handledPdfRef.current === pdfFetcher.data) return;
    handledPdfRef.current = pdfFetcher.data;

    const data = pdfFetcher.data;
    if (data.status === "success" && data.result?.base64) {
      const { base64, contentType, filename } = data.result;
      // Decode base64 → bytes → Blob → blob: URL.
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: contentType || "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);

      const win = pdfWindowRef.current;
      if (win && !win.closed) {
        // Set a sensible title for the tab via document.title once loaded.
        win.location.href = blobUrl;
        try {
          win.document.title = filename;
        } catch {
          // cross-origin or not-yet-loaded — ignore
        }
      } else {
        // Popup was blocked or already closed — fall back to download.
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename || "invoice.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Browsers eventually GC blob URLs after the new tab loads them.
      // Revoking immediately can race with the navigation; revoke later.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      pdfWindowRef.current = null;
    } else if (data.status === "error") {
      // Close the placeholder window if the fetch failed.
      const win = pdfWindowRef.current;
      if (win && !win.closed) win.close();
      pdfWindowRef.current = null;
      setBannerError(data.message || "Failed to load QBO invoice PDF");
      shopify?.toast?.show(data.message || "Failed to load PDF", { isError: true });
    }
  }, [pdfFetcher.data, pdfFetcher.state, shopify]);

  const pdfLoading =
    pdfFetcher.state === "submitting" || pdfFetcher.state === "loading";

  // "Send invoice" button → POST /api/admin/orders/:id/send-invoice.
  // QBO mails the CURRENT invoice document, so no client-side payload
  // is needed.
  const onSendInvoice = () => {
    setBannerError(null);
    setBannerSuccess(null);
    sendInvoiceFetcher.submit(null, {
      method: "POST",
      action: `/api/admin/orders/${order._id}/send-invoice`,
    });
  };

  // Resolve the send-invoice fetcher → toast + banner. React Router
  // auto-revalidates the loader after the action, so the QuickBooks-
  // invoice section will refresh and the new Email status / Last
  // updated values reflect the send.
  useEffect(() => {
    if (!sendInvoiceFetcher.data) return;
    if (sendInvoiceFetcher.state !== "idle") return;
    if (handledSendInvoiceRef.current === sendInvoiceFetcher.data) return;
    handledSendInvoiceRef.current = sendInvoiceFetcher.data;

    const data = sendInvoiceFetcher.data;
    if (data.status === "success") {
      setBannerSuccess(data.message || "Invoice email sent");
      shopify?.toast?.show(data.message || "Invoice email sent");
    } else {
      setBannerError(data.message || "Could not send invoice email");
      shopify?.toast?.show(data.message || "Send failed", { isError: true });
    }
  }, [sendInvoiceFetcher.data, sendInvoiceFetcher.state, shopify]);

  const sendInvoiceLoading =
    sendInvoiceFetcher.state === "submitting" ||
    sendInvoiceFetcher.state === "loading";

  const outstanding =
    invoice != null
      ? Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
      : null;

  // Per-method fee preview for the confirmation modals. Mirrors the
  // server's computeProcessingFee so the breakdown shown in-modal
  // exactly matches what propagateSuccessfulPayment will append to QBO.
  // Returns null when no fee applies (rate=0 or already-applied invoice).
  const previewFee = (method) => {
    if (outstanding == null || outstanding <= 0) return null;
    if (invoice?.processingFeeAppliedAt) return null; // already on invoice
    return computeProcessingFee({
      baseAmount: outstanding,
      method,
      rates: processingFeeRates,
    });
  };
  const cardFeePreview = previewFee("card");
  const cardFeeTotal =
    outstanding != null
      ? Number(((outstanding ?? 0) + (cardFeePreview?.amount ?? 0)).toFixed(2))
      : null;

  return (
    <s-page inlineSize="large" heading={`Order ${orderLabel}`}>
      <s-button
        slot="back-action"
        icon="arrow-left"
        accessibilityLabel="Back to orders"
        onClick={() => navigate("/app/orders")}
      >
        Back
      </s-button>
      {invoice &&
        (isCardInvoice || isAchInvoice) &&
        invoice.paymentStatus !== "paid" &&
        invoice.paymentStatus !== "cancelled" && (
          <s-button
            slot="primary-action"
            variant="primary"
            disabled={!canRetry}
            onClick={() => modalRef.current?.showOverlay?.()}
            {...(retrying ? { loading: true } : {})}
          >
            {isAchInvoice ? "Retry ACH payment" : "Retry payment"}
          </s-button>
        )}
      {invoice && isChequeInvoice && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!canMarkChequePaid}
          onClick={() => {
            const outstandingForForm =
              invoice != null
                ? Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
                : 0;
            setChequeAmount(String(outstandingForForm));
            chequeModalRef.current?.showOverlay?.();
          }}
          {...(chequeSubmitting ? { loading: true } : {})}
        >
          Mark cheque paid
        </s-button>
      )}
      {invoice && isManualInvoice && (
        <s-button
          slot="secondary-actions"
          disabled={!canChargeCard}
          onClick={() => chargeCardModalRef.current?.showOverlay?.()}
          {...(chargeCardSubmitting ? { loading: true } : {})}
        >
          Charge card on file
        </s-button>
      )}
      {/* Sync ACH status — on-demand reconciliation with NMI. Shown only
          for ACH invoices that have an in-flight transaction awaiting
          settlement (the same set the CRON sweeps). Disabled while a sync
          is already running (this tab, another tab, or a CRON tick). */}
      {invoice && isAchAwaitingSettlement && (
        <s-button
          slot="secondary-actions"
          disabled={!canSyncAch}
          onClick={onSyncAch}
          {...(syncingAch ? { loading: true } : {})}
        >
          Sync ACH status
        </s-button>
      )}
      {/* Pause / Resume auto-charge — card-preferred invoices only.
          One button at a time: the live `autoChargePaused` flag picks
          which one to render so admins always see the action that
          moves the invoice. */}
      {invoice && isCardPreferredInvoice && !autoChargePaused && (
        <s-button
          slot="secondary-actions"
          disabled={!canPauseAutoCharge}
          onClick={() => pauseAutoChargeModalRef.current?.showOverlay?.()}
          {...(pauseAutoChargeSubmitting ? { loading: true } : {})}
        >
          Pause auto-charge
        </s-button>
      )}
      {invoice && isCardPreferredInvoice && autoChargePaused && (
        <s-button
          slot="secondary-actions"
          disabled={!canResumeAutoCharge}
          onClick={() => resumeAutoChargeModalRef.current?.showOverlay?.()}
          {...(resumeAutoChargeSubmitting ? { loading: true } : {})}
        >
          Resume auto-charge
        </s-button>
      )}
      {/* Pause / Resume email reminders — cheque invoices only. One
          button at a time, picked by the live `reminderPaused` flag. */}
      {invoice && isChequeInvoice && !reminderPaused && (
        <s-button
          slot="secondary-actions"
          disabled={!canPauseReminders}
          onClick={() => pauseRemindersModalRef.current?.showOverlay?.()}
          {...(pauseRemindersSubmitting ? { loading: true } : {})}
        >
          Pause auto email notifications
        </s-button>
      )}
      {invoice && isChequeInvoice && reminderPaused && (
        <s-button
          slot="secondary-actions"
          disabled={!canResumeReminders}
          onClick={() => resumeRemindersModalRef.current?.showOverlay?.()}
          {...(resumeRemindersSubmitting ? { loading: true } : {})}
        >
          Resume auto email notifications
        </s-button>
      )}

      <s-box paddingBlockStart="large-200" />

      {bannerSuccess && (
        <s-banner tone="success" heading="Retry succeeded">
          <s-paragraph>{bannerSuccess}</s-paragraph>
        </s-banner>
      )}
      {bannerError && (
        <s-banner tone="critical" heading="Retry did not succeed">
          <s-paragraph>{bannerError}</s-paragraph>
        </s-banner>
      )}

      {/* ───── Status pipeline ───── */}
      <s-section heading="Status pipeline">
        <s-stack
          direction="inline"
          gap="base"
          alignItems="start"
          wrap
        >
          {pipelineSteps.map((step, i) => (
            <Fragment key={step.label}>
              <PipelineStepBadge step={step} />
              {i < pipelineSteps.length - 1 && <PipelineConnector />}
            </Fragment>
          ))}
        </s-stack>
      </s-section>

      {/* ───── Overview ───── */}
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <ProcessingBadge
              status={order.processingStatus}
              paymentMethod={invoice?.paymentMethod}
            />
            {order.rejectionCode && (
              <s-badge tone="critical">{order.rejectionCode}</s-badge>
            )}
            {order.receivedAt && (
              <s-text tone="subdued">
                Received {new Date(order.receivedAt).toLocaleString()}
              </s-text>
            )}
            {order.processingStatus === "completed" && order.completedAt && (
              <s-text tone="subdued">
                · Completed {new Date(order.completedAt).toLocaleString()}
              </s-text>
            )}
          </s-stack>

          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
            <s-grid-item>
              <KV label="Shopify order ID" value={order.shopifyOrderId} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Shopify order number" value={order.shopifyOrderNumber} />
            </s-grid-item>
            <s-grid-item>
              <KV
                label="Total amount"
                value={
                  order.totalAmount != null
                    ? formatAmount(order.totalAmount, order.currency)
                    : null
                }
              />
            </s-grid-item>
            <s-grid-item>
              <KV label="Financial status" value={order.financialStatus} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Fulfillment status" value={order.fulfillmentStatus} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Currency" value={order.currency} />
            </s-grid-item>
          </s-grid>

          {order.processingError && (
            <s-banner tone="warning" heading="Last processing error">
              <s-paragraph>{order.processingError}</s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      {/* ───── Line items + totals ───── */}
      <s-section
        heading={`Line items (${breakdown?.lineItems?.length ?? 0})`}
      >
        {!breakdown?.lineItems?.length ? (
          <s-paragraph tone="subdued">
            No line items recorded for this order.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header>Product</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Qty</s-table-header>
                <s-table-header>Unit price</s-table-header>
                <s-table-header>Discount</s-table-header>
                <s-table-header>Line total</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {breakdown.lineItems.map((li) => (
                  <s-table-row key={li.id || `${li.name}-${li.sku}`}>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{li.name}</s-text>
                        {li.variantTitle && (
                          <s-text tone="subdued">{li.variantTitle}</s-text>
                        )}
                        {li.vendor && (
                          <s-text tone="subdued">by {li.vendor}</s-text>
                        )}
                        {li.giftCard && <s-badge tone="info">Gift card</s-badge>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{li.sku || "—"}</s-table-cell>
                    <s-table-cell>{li.quantity}</s-table-cell>
                    <s-table-cell>
                      {formatAmount(li.unitPrice, breakdown.currency)}
                    </s-table-cell>
                    <s-table-cell>
                      {li.discount > 0
                        ? `− ${formatAmount(li.discount, breakdown.currency)}`
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {formatAmount(li.lineTotal, breakdown.currency)}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            {breakdown.totals && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <TotalsRow
                    label="Subtotal"
                    value={formatAmount(breakdown.totals.subtotal, breakdown.currency)}
                  />
                  {breakdown.totals.discounts > 0 && (
                    <TotalsRow
                      label="Discounts"
                      value={`− ${formatAmount(breakdown.totals.discounts, breakdown.currency)}`}
                      tone="success"
                    />
                  )}
                  {breakdown.totals.shipping > 0 && (
                    <TotalsRow
                      label="Shipping"
                      value={formatAmount(breakdown.totals.shipping, breakdown.currency)}
                    />
                  )}
                  <TotalsRow
                    label={
                      breakdown.totals.taxesIncluded
                        ? "Tax (included)"
                        : "Tax"
                    }
                    value={formatAmount(breakdown.totals.tax, breakdown.currency)}
                  />
                  <s-divider />
                  <TotalsRow
                    label="Grand total"
                    value={formatAmount(breakdown.totals.grandTotal, breakdown.currency)}
                    strong
                  />
                </s-stack>
              </s-box>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Customer ───── */}
      <s-section heading="Customer">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
          <s-grid-item>
            <KV label="Email" value={order.customerEmail} />
          </s-grid-item>
          <s-grid-item>
            <KV label="Shopify customer ID" value={order.shopifyCustomerId} />
          </s-grid-item>
          <s-grid-item>
            <KV label="QBO customer ID" value={customerMap?.qboCustomerId} />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="NMI vault ID"
              value={
                customerMap?.nmiCustomerVaultId || (
                  <s-text tone="subdued">— no vault on file</s-text>
                )
              }
            />
          </s-grid-item>
          <s-grid-item>
            <KV
              label="Customer name"
              value={
                customerMap?.profile
                  ? [customerMap.profile.firstName, customerMap.profile.lastName]
                      .filter(Boolean)
                      .join(" ")
                  : null
              }
            />
          </s-grid-item>
          <s-grid-item>
            <KV label="Company" value={customerMap?.profile?.companyName} />
          </s-grid-item>
        </s-grid>
      </s-section>

      {/* ───── Invoice & payment ───── */}
      <s-section heading="Invoice & payment">
        {!invoice ? (
          <s-paragraph tone="subdued">
            No invoice has been created for this order yet.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <PaymentStatusBadge status={invoice.paymentStatus} />
              <PaymentMethodBadge method={paymentMethod} />
              <s-text tone="subdued">
                {invoice.attemptCount}/{invoice.maxAttempts} attempts
              </s-text>
              {/* Auto-charge badge — only meaningful for card-
                  preferred invoices. Cheque/ACH invoices are already
                  CRON-excluded by paymentMethod filter, so showing
                  "Active" there would imply something it doesn't. */}
              {isCardPreferredInvoice && (
                <s-badge tone={autoChargePaused ? "warning" : "success"}>
                  {autoChargePaused
                    ? "Auto-charge paused"
                    : "Auto-charge active"}
                </s-badge>
              )}
              {/* Email-reminder badge — only meaningful for cheque
                  invoices (the only ones the reminder CRON emails). */}
              {isChequeInvoice && (
                <s-badge tone={reminderPaused ? "warning" : "success"}>
                  {reminderPaused
                    ? "Email reminders paused"
                    : "Email reminders active"}
                </s-badge>
              )}
            </s-stack>

            {/* Paused-state context banner — surfaces who paused it,
                when, and the optional pause note so admins reviewing
                the order know why CRON is being skipped without
                digging into the remarks ledger. */}
            {isCardPreferredInvoice && autoChargePaused && (
              <s-banner tone="warning" heading="Auto-charge is paused">
                <s-paragraph>
                  The CRON scheduler will skip this invoice on every tick
                  until an admin resumes it. Manual settlement actions
                  (Retry payment, Mark cheque paid, Charge card on file)
                  remain available.
                </s-paragraph>
                <s-paragraph tone="subdued">
                  Paused{" "}
                  {invoice.autoChargePausedAt
                    ? `on ${new Date(invoice.autoChargePausedAt).toLocaleString()}`
                    : ""}
                  {invoice.autoChargePausedBy
                    ? ` by ${invoice.autoChargePausedBy}`
                    : ""}
                  {invoice.autoChargePauseNote
                    ? ` — "${invoice.autoChargePauseNote}"`
                    : ""}
                  .
                </s-paragraph>
              </s-banner>
            )}

            {/* Email-reminder paused banner — surfaces who muted the
                reminder CRON, when, and why, so admins know automated
                emails are intentionally stopped for this invoice. */}
            {isChequeInvoice && reminderPaused && (
              <s-banner tone="warning" heading="Auto email reminders are paused">
                <s-paragraph>
                  The reminder scheduler will not send any further payment
                  reminder emails (Day 9 / 11 / 13) for this invoice until
                  an admin resumes. Payment collection is unaffected — this
                  pauses notifications only.
                </s-paragraph>
                <s-paragraph tone="subdued">
                  Paused{" "}
                  {invoice.reminderPausedAt
                    ? `on ${new Date(invoice.reminderPausedAt).toLocaleString()}`
                    : ""}
                  {invoice.reminderPausedBy
                    ? ` by ${invoice.reminderPausedBy}`
                    : ""}
                  {invoice.reminderPauseNote
                    ? ` — "${invoice.reminderPauseNote}"`
                    : ""}
                  .
                </s-paragraph>
              </s-banner>
            )}

            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
              <s-grid-item>
                <KV
                  label="Customer preference (at order)"
                  value={
                    PAYMENT_METHOD_LABEL[orderTimePreference] ||
                    orderTimePreference
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Active method"
                  value={PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Settled via"
                  value={
                    settledMethods.length > 1
                      ? settledMethods
                          .map((m) => PAYMENT_METHOD_LABEL[m] || m)
                          .join(" + ")
                      : settledVia
                        ? PAYMENT_METHOD_LABEL[settledVia] || settledVia
                        : settledMethods.length === 1
                          ? PAYMENT_METHOD_LABEL[settledMethods[0]] ||
                            settledMethods[0]
                          : invoice.paymentStatus === "cancelled"
                            ? "—"
                            : "(not yet settled)"
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV label="QBO invoice ID" value={invoice.qboInvoiceId} />
              </s-grid-item>
              <s-grid-item>
                <KV label="QBO doc number" value={invoice.qboDocNumber} />
              </s-grid-item>
              <s-grid-item>
                <KV label="QBO creation status" value={invoice.qboCreationStatus} />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Payment due"
                  value={
                    invoice.qboDueDate
                      ? formatDueDate(invoice.qboDueDate, invoice.paymentStatus)
                      : null
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Amount due"
                  value={formatAmount(invoice.amountDue, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Amount paid"
                  value={formatAmount(invoice.amountPaid, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Outstanding"
                  value={formatAmount(outstanding, invoice.currency)}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Last attempt"
                  value={
                    invoice.lastAttemptAt
                      ? new Date(invoice.lastAttemptAt).toLocaleString()
                      : null
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Paid at"
                  value={
                    invoice.paidAt
                      ? new Date(invoice.paidAt).toLocaleString()
                      : null
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="QBO payment recorded"
                  value={invoice.qboPaymentRecorded ? "Yes" : "No"}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Shopify marked paid"
                  value={invoice.shopifyMarkedPaid ? "Yes" : "No"}
                />
              </s-grid-item>
              {isCardPreferredInvoice && (
                <>
                  <s-grid-item>
                    <KV
                      label="Auto-charge status"
                      value={
                        autoChargePaused ? (
                          <s-text tone="critical">Paused</s-text>
                        ) : (
                          <s-text tone="success">Active</s-text>
                        )
                      }
                    />
                  </s-grid-item>
                  <s-grid-item>
                    {/* Show whichever timestamp is more recent so the
                        single row tells the right story without
                        cluttering the grid with two columns. */}
                    {autoChargePaused ? (
                      <KV
                        label="Paused at"
                        value={
                          invoice.autoChargePausedAt
                            ? `${new Date(invoice.autoChargePausedAt).toLocaleString()}${
                                invoice.autoChargePausedBy
                                  ? ` by ${invoice.autoChargePausedBy}`
                                  : ""
                              }`
                            : null
                        }
                      />
                    ) : (
                      <KV
                        label="Last resumed"
                        value={
                          invoice.autoChargeResumeAt
                            ? `${new Date(invoice.autoChargeResumeAt).toLocaleString()}${
                                invoice.autoChargeResumedBy
                                  ? ` by ${invoice.autoChargeResumedBy}`
                                  : ""
                              }`
                            : null
                        }
                      />
                    )}
                  </s-grid-item>
                </>
              )}
            </s-grid>

            {invoice.lastAttemptError && (
              <s-banner tone="warning" heading="Last attempt error">
                <s-paragraph>{invoice.lastAttemptError}</s-paragraph>
              </s-banner>
            )}
            {invoice.qboCreationError && (
              <s-banner tone="critical" heading="QBO creation error">
                <s-paragraph>{invoice.qboCreationError}</s-paragraph>
              </s-banner>
            )}
            {invoice.lastSyncError && (
              <s-banner tone="warning" heading="Last sync error">
                <s-paragraph>{invoice.lastSyncError}</s-paragraph>
              </s-banner>
            )}

            {invoice && (isCardInvoice || isAchInvoice) && !canRetry && (
              <s-paragraph tone="subdued">
                {invoice.paymentStatus === "paid"
                  ? "This invoice is already paid."
                  : invoice.paymentStatus === "cancelled"
                    ? "This invoice has been cancelled."
                    : invoice.paymentStatus === "in_progress"
                      ? "A charge is currently in progress — wait for it to finish."
                      : invoice.paymentStatus === "awaiting_settlement"
                        ? "An ACH transaction was submitted to NMI and is awaiting settlement (typically 1–3 business days). No new charge can run until the bank confirms or returns the original transaction."
                        : !customerMap?.nmiCustomerVaultId
                          ? "No NMI customer vault on file for this customer — collect a payment method before retrying."
                          : isAchInvoice && !customerMap?.nmiAchBillingId
                            ? "No NMI ACH billing id on file for this customer — capture the ACH billing profile in NMI (or fall back to charging the card on file) before retrying."
                            : null}
              </s-paragraph>
            )}
            {invoice && invoice.paymentStatus === "awaiting_settlement" && (
              <s-banner tone="info" heading="ACH awaiting settlement">
                <s-paragraph>
                  NMI accepted the ACH submission
                  {invoice.pendingSettlementTxnId
                    ? ` (transaction ${invoice.pendingSettlementTxnId})`
                    : ""}
                  {invoice.pendingSettlementAmount
                    ? ` for ${formatAmount(invoice.pendingSettlementAmount, invoice.currency)}`
                    : ""}
                  . The ACH network typically takes 1–3 business days to
                  confirm. The invoice will be marked Paid once NMI
                  reports the transaction as Complete, or returned to
                  Pending if the bank rejects the debit.
                </s-paragraph>
              </s-banner>
            )}
            {/* Result of the most recent on-demand "Sync ACH status" click. */}
            {achSyncBanner && (
              <s-banner tone={achSyncBanner.tone} heading={achSyncBanner.heading}>
                <s-paragraph>{achSyncBanner.text}</s-paragraph>
              </s-banner>
            )}
            {/* Last synchronization timestamp + latest status NMI returned —
                covers BOTH the manual button and the scheduled CRON sweep. */}
            {invoice && isAchInvoice && invoice.achSyncLastAt && (
              <s-stack direction="inline" gap="base" alignItems="center" wrap>
                <s-text tone="subdued">
                  Last ACH sync:{" "}
                  {new Date(invoice.achSyncLastAt).toLocaleString()}
                </s-text>
                {(() => {
                  const meta =
                    ACH_SYNC_STATUS_META[invoice.achSyncLastStatus] || {
                      label: invoice.achSyncLastStatus,
                      tone: "default",
                    };
                  return <s-badge tone={meta.tone}>{meta.label}</s-badge>;
                })()}
                <s-text tone="subdued">
                  via{" "}
                  {invoice.achSyncLastSource === "admin_manual_sync"
                    ? "manual sync"
                    : "scheduled sync"}
                  {invoice.achSyncLastSource === "admin_manual_sync" &&
                  invoice.achSyncLastBy
                    ? ` (${invoice.achSyncLastBy})`
                    : ""}
                </s-text>
              </s-stack>
            )}
            {invoice && isManualInvoice && (
              <s-paragraph tone="subdued">
                {invoice.paymentStatus === "paid"
                  ? "This invoice is already paid."
                  : invoice.paymentStatus === "cancelled"
                    ? "This invoice has been cancelled."
                    : invoice.paymentStatus === "in_progress"
                      ? "A charge is currently in progress — wait for it to finish."
                      : isAchInvoice
                        ? `Customer chose ${PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod}. The scheduler auto-charges the ACH billing profile on file. If ACH fails, fall back to charging the card on file.`
                        : `Customer chose ${PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod}. The scheduler will not auto-charge — record the cheque manually once received, or fall back to charging the card on file.`}
              </s-paragraph>
            )}
            {invoice &&
              isManualInvoice &&
              statusAllowsAction &&
              !customerMap?.nmiCustomerVaultId && (
                <s-banner tone="warning" heading="No card on file">
                  <s-paragraph>
                    This customer didn&apos;t save a card at registration, so
                    the &quot;Charge card on file&quot; fallback is unavailable.
                    Use &quot;Mark cheque paid&quot; when payment arrives, or
                    capture a card on file via NMI directly and then refresh
                    this page.
                  </s-paragraph>
                </s-banner>
              )}

            {paymentHistoryRows.length > 0 && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-text>
                      <strong>
                        Payment history ({paymentHistoryRows.length})
                      </strong>
                    </s-text>
                    <s-text tone="subdued">
                      Total received:{" "}
                      <strong>
                        {formatAmount(totalReceived, invoice.currency)}
                      </strong>
                      {" "}of{" "}
                      {formatAmount(invoice.amountDue, invoice.currency)}
                    </s-text>
                  </s-stack>
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>#</s-table-header>
                      <s-table-header>Method</s-table-header>
                      <s-table-header>Amount</s-table-header>
                      <s-table-header>Reference</s-table-header>
                      <s-table-header>When</s-table-header>
                      <s-table-header>Notes</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {paymentHistoryRows.map((row, idx) => (
                        <s-table-row key={row.key}>
                          <s-table-cell>{idx + 1}</s-table-cell>
                          <s-table-cell>
                            <s-stack direction="block" gap="none">
                              <PaymentMethodBadge method={row.method} />
                              <s-text tone="subdued">
                                {row.source === "nmi"
                                  ? "NMI charge"
                                  : row.method === "ach"
                                    ? "Manual ACH"
                                    : "Manual cheque"}
                              </s-text>
                            </s-stack>
                          </s-table-cell>
                          <s-table-cell>
                            {formatAmount(row.amount, row.currency)}
                          </s-table-cell>
                          <s-table-cell>
                            {row.reference ? (
                              <s-stack direction="block" gap="none">
                                <s-text>
                                  {row.source === "nmi"
                                    ? `NMI txn ${row.reference}`
                                    : `Ref ${row.reference}`}
                                </s-text>
                                {row.authCode && (
                                  <s-text tone="subdued">
                                    Auth {row.authCode}
                                  </s-text>
                                )}
                              </s-stack>
                            ) : (
                              <s-text tone="subdued">—</s-text>
                            )}
                          </s-table-cell>
                          <s-table-cell>
                            {row.when
                              ? new Date(row.when).toLocaleString()
                              : "—"}
                          </s-table-cell>
                          <s-table-cell>
                            {row.response ? (
                              <s-text>{row.response}</s-text>
                            ) : (
                              <s-text tone="subdued">—</s-text>
                            )}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </s-stack>
              </s-box>
            )}

          </s-stack>
        )}
      </s-section>

      {/* ───── QuickBooks invoice (live fetch) ───── */}
      {invoice?.qboInvoiceId && (
        <s-section heading="QuickBooks invoice">
          <s-stack direction="block" gap="base">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-stack direction="inline" gap="base" alignItems="center">
                {qbo?.invoice?.docNumber && (
                  <s-badge tone="info">#{qbo.invoice.docNumber}</s-badge>
                )}
                <s-text tone="subdued">
                  QBO id: {invoice.qboInvoiceId}
                </s-text>
                {qbo?.url && (
                  <s-link href={qbo.url} target="_blank">
                    Open in QuickBooks ↗
                  </s-link>
                )}
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="secondary"
                  onClick={onSendInvoice}
                  {...(sendInvoiceLoading ? { loading: true } : {})}
                >
                  Send invoice
                </s-button>
                <s-button
                  variant="secondary"
                  onClick={onViewPdf}
                  {...(pdfLoading ? { loading: true } : {})}
                >
                  View invoice PDF
                </s-button>
              </s-stack>
            </s-stack>

            {qbo?.error && (
              <s-banner
                tone="warning"
                heading="Could not load live QBO invoice"
              >
                <s-paragraph>{qbo.error}</s-paragraph>
                <s-paragraph tone="subdued">
                  The local mirror above still shows what we recorded at
                  creation time. Use the QuickBooks link to view the
                  current state.
                </s-paragraph>
              </s-banner>
            )}

            {qbo?.invoice && (
              <>
                <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
                  <s-grid-item>
                    <KV label="Customer" value={qbo.invoice.customerName} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Bill email" value={qbo.invoice.billEmail} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Currency" value={qbo.invoice.currency} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Txn date" value={qbo.invoice.txnDate} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Due date" value={qbo.invoice.dueDate} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV
                      label="Created"
                      value={
                        qbo.invoice.createTime
                          ? new Date(qbo.invoice.createTime).toLocaleString()
                          : null
                      }
                    />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Email status" value={qbo.invoice.emailStatus} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV label="Print status" value={qbo.invoice.printStatus} />
                  </s-grid-item>
                  <s-grid-item>
                    <KV
                      label="Last updated"
                      value={
                        qbo.invoice.lastUpdatedTime
                          ? new Date(qbo.invoice.lastUpdatedTime).toLocaleString()
                          : null
                      }
                    />
                  </s-grid-item>
                </s-grid>

                {qbo.invoice.lines.length === 0 ? (
                  <s-paragraph tone="subdued">
                    QBO invoice has no item lines.
                  </s-paragraph>
                ) : (
                  <s-table>
                    <s-table-header-row>
                      <s-table-header>#</s-table-header>
                      <s-table-header>Item</s-table-header>
                      <s-table-header>Description</s-table-header>
                      <s-table-header>Qty</s-table-header>
                      <s-table-header>Unit price</s-table-header>
                      <s-table-header>Amount</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {qbo.invoice.lines.map((l, i) => (
                        <s-table-row key={l.id || i}>
                          <s-table-cell>{l.lineNum ?? i + 1}</s-table-cell>
                          <s-table-cell>{l.itemName || "—"}</s-table-cell>
                          <s-table-cell>{l.description || "—"}</s-table-cell>
                          <s-table-cell>{l.qty ?? "—"}</s-table-cell>
                          <s-table-cell>
                            {l.unitPrice != null
                              ? formatAmount(l.unitPrice, qbo.invoice.currency)
                              : "—"}
                          </s-table-cell>
                          <s-table-cell>
                            {l.amount != null
                              ? formatAmount(l.amount, qbo.invoice.currency)
                              : "—"}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}

                <s-box
                  padding="base"
                  border="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <s-stack direction="block" gap="tight">
                    <TotalsRow
                      label="Tax"
                      value={formatAmount(qbo.invoice.totalTax, qbo.invoice.currency)}
                    />
                    <TotalsRow
                      label="Total"
                      value={formatAmount(qbo.invoice.totalAmt, qbo.invoice.currency)}
                    />
                    <s-divider />
                    <TotalsRow
                      label="Balance due"
                      value={formatAmount(qbo.invoice.balance, qbo.invoice.currency)}
                      strong
                      tone={qbo.invoice.balance === 0 ? "success" : undefined}
                    />
                  </s-stack>
                </s-box>

                {qbo.invoice.privateNote && (
                  <s-box
                    padding="base"
                    border="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="block" gap="none">
                      <s-text tone="subdued">QBO private note</s-text>
                      <s-text>{qbo.invoice.privateNote}</s-text>
                    </s-stack>
                  </s-box>
                )}

                {qbo.invoice.linkedPayments.length > 0 && (
                  <s-paragraph tone="subdued">
                    Linked QBO payments:{" "}
                    {qbo.invoice.linkedPayments.map((p) => p.id).join(", ")}
                  </s-paragraph>
                )}
              </>
            )}
          </s-stack>
        </s-section>
      )}

      {/* ───── Email history ───── */}
      {invoice && (
        <s-section
          heading={`Email history (${invoice.emailEvents?.length || 0})`}
        >
          {!invoice.emailEvents || invoice.emailEvents.length === 0 ? (
            <s-paragraph tone="subdued">
              No invoice emails have been sent yet for this order.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Type</s-table-header>
                <s-table-header>Trigger</s-table-header>
                <s-table-header>Recipient</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Triggered by</s-table-header>
                <s-table-header>Detail</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...invoice.emailEvents]
                  .sort((a, b) =>
                    String(b.createdAt).localeCompare(String(a.createdAt)),
                  )
                  .map((e, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>
                        {e.createdAt
                          ? new Date(e.createdAt).toLocaleString()
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={e.triggerType === "manual" ? "info" : "default"}
                        >
                          {e.triggerType === "manual" ? "Manual" : "Auto"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{EMAIL_SOURCE_LABEL[e.source] || e.source}</s-table-cell>
                      <s-table-cell>{e.recipient || "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={e.status === "sent" ? "success" : "critical"}
                        >
                          {e.status === "sent" ? "Sent" : "Failed"}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>{e.triggeredBy || "—"}</s-table-cell>
                      <s-table-cell>
                        {e.status === "failed" && e.errorMessage
                          ? e.errorMessage
                          : e.paymentStatusSnapshot
                            ? `${e.paymentStatusSnapshot}${
                                e.amountPaidSnapshot != null
                                  ? ` · paid ${formatAmount(
                                      e.amountPaidSnapshot,
                                      invoice.currency,
                                    )}`
                                  : ""
                              }`
                            : "—"}
                      </s-table-cell>
                    </s-table-row>
                  ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      {/* ───── Attempt history ───── */}
      {invoice && (
        <s-section heading={`Attempt history (${attempts.length})`}>
          {attempts.length === 0 ? (
            <s-paragraph tone="subdued">No charge attempts yet.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>#</s-table-header>
                <s-table-header>When</s-table-header>
                <s-table-header>Outcome</s-table-header>
                <s-table-header>Amount</s-table-header>
                <s-table-header>NMI txn</s-table-header>
                <s-table-header>Code</s-table-header>
                <s-table-header>Response</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {attempts.map((a) => (
                  <s-table-row key={a._id}>
                    <s-table-cell>{a.attemptNumber}</s-table-cell>
                    <s-table-cell>
                      {a.attemptedAt
                        ? new Date(a.attemptedAt).toLocaleString()
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <OutcomeBadge outcome={a.outcome} />
                    </s-table-cell>
                    <s-table-cell>
                      {formatAmount(a.amount, a.currency)}
                    </s-table-cell>
                    <s-table-cell>{a.nmiTransactionId || "—"}</s-table-cell>
                    <s-table-cell>{a.nmiResponseCode || "—"}</s-table-cell>
                    <s-table-cell>
                      {a.nmiResponseText || a.errorMessage || "—"}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      {/* ───── Remarks (CRON + admin follow-up timeline) ───── */}
      {invoice && (
        <s-section heading={`Remarks (${invoice.remarks?.length || 0})`}>
          {!invoice.remarks?.length ? (
            <s-paragraph tone="subdued">
              No remarks yet. CRON ticks and admin settlement actions
              (retry, charge card, mark cheque/ACH paid) append entries
              here automatically.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Kind</s-table-header>
                <s-table-header>Source</s-table-header>
                <s-table-header>Message</s-table-header>
                <s-table-header>Amount</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {/* Newest-first — remarks[] is append-only so the
                    server-side order is chronological ascending. */}
                {[...invoice.remarks].reverse().map((r, i) => {
                  const meta = REMARK_KIND_META[r.kind] || {
                    label: r.kind || "—",
                    tone: "default",
                  };
                  return (
                    <s-table-row key={`${r.createdAt || i}-${i}`}>
                      <s-table-cell>
                        {r.createdAt
                          ? new Date(r.createdAt).toLocaleString()
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone={meta.tone}>{meta.label}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text tone="subdued">
                          {r.source === "admin"
                            ? "Admin"
                            : r.source === "cron"
                              ? "CRON"
                              : "System"}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>{r.message || "—"}</s-table-cell>
                      <s-table-cell>
                        {r.amount != null
                          ? formatAmount(
                              r.amount,
                              r.currency || invoice.currency,
                            )
                          : "—"}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}

      <s-modal
        ref={modalRef}
        id="retry-payment-modal"
        heading="Retry payment for this order?"
        accessibilityLabel="Retry payment confirmation"
      >
        <s-paragraph>
          This will charge the customer&apos;s NMI vault right now. If the
          charge succeeds, the QBO invoice will be marked paid and the
          Shopify order will be flagged paid as well.
        </s-paragraph>
        <s-paragraph>
          <strong>Payment breakdown</strong>
        </s-paragraph>
        <s-paragraph>
          Invoice balance:{" "}
          <strong>{formatAmount(outstanding ?? 0, invoice?.currency)}</strong>
          <br />
          {cardFeePreview ? (
            <>
              {processingFeeLabel("card")} (
              {+(cardFeePreview.rate * 100).toFixed(4)}
              %):{" "}
              <strong>
                {formatAmount(cardFeePreview.amount, invoice?.currency)}
              </strong>
              <br />
              <strong>
                Total to charge:{" "}
                {formatAmount(cardFeeTotal ?? 0, invoice?.currency)}
              </strong>
              <br />
              <s-text tone="subdued" size="small">
                The processing fee will be added as a separate line on the QBO
                invoice once the charge is approved.
              </s-text>
            </>
          ) : (
            <strong>
              Total to charge:{" "}
              {formatAmount(outstanding ?? 0, invoice?.currency)}
            </strong>
          )}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmRetry}
          {...(retrying ? { loading: true } : {})}
        >
          Charge now
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => modalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={chequeModalRef}
        id="mark-cheque-paid-modal"
        heading="Record cheque payment"
        accessibilityLabel="Record cheque payment"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Record a manual cheque receipt against this invoice. The QBO invoice
            will be marked paid (with the cheque reference) and the Shopify
            order will be flagged paid.
          </s-paragraph>
          <s-text tone="subdued">
            Outstanding balance:{" "}
            <strong>{formatAmount(outstanding ?? 0, invoice?.currency)}</strong>
          </s-text>
          <s-text-field
            label="Cheque reference"
            placeholder="e.g. 1042"
            value={chequeReference}
            required
            onChange={(e) => setChequeReference(e.currentTarget.value)}
          />
          <s-text-field
            label="Amount"
            type="number"
            min="0.01"
            step="0.01"
            value={chequeAmount}
            onChange={(e) => setChequeAmount(e.currentTarget.value)}
            details="Defaults to the full outstanding balance"
          />
          <s-date-field
            label="Received on"
            value={chequeReceivedAt}
            onChange={(e) => setChequeReceivedAt(e.currentTarget.value)}
            details="Defaults to today"
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmCheque}
          {...(chequeSubmitting ? { loading: true } : {})}
        >
          Mark cheque paid
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => chequeModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={chargeCardModalRef}
        id="charge-card-modal"
        heading="Charge the card on file?"
        accessibilityLabel="Charge card fallback confirmation"
      >
        <s-paragraph>
          Customer chose{" "}
          <strong>
            {PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod}
          </strong>{" "}
          for this invoice, but no cheque was received. Charging the card on
          file now will switch this invoice&apos;s payment method to credit
          card and attempt an NMI sale. The customer&apos;s default preference
          will not change for future orders.
        </s-paragraph>
        <s-paragraph>
          <strong>Payment breakdown</strong>
        </s-paragraph>
        <s-paragraph>
          Invoice balance:{" "}
          <strong>{formatAmount(outstanding ?? 0, invoice?.currency)}</strong>
          <br />
          {cardFeePreview ? (
            <>
              {processingFeeLabel("card")} (
              {+(cardFeePreview.rate * 100).toFixed(4)}
              %):{" "}
              <strong>
                {formatAmount(cardFeePreview.amount, invoice?.currency)}
              </strong>
              <br />
              <strong>
                Total to charge:{" "}
                {formatAmount(cardFeeTotal ?? 0, invoice?.currency)}
              </strong>
              <br />
              <s-text tone="subdued" size="small">
                The processing fee will be added as a separate line on the QBO
                invoice once the charge is approved.
              </s-text>
            </>
          ) : (
            <>
              <strong>
                Total to charge:{" "}
                {formatAmount(outstanding ?? 0, invoice?.currency)}
              </strong>
              {invoice?.processingFeeAppliedAt ? (
                <>
                  <br />
                  <s-text tone="subdued" size="small">
                    A {invoice.processingFeeMethod || "processing"} fee of{" "}
                    {formatAmount(
                      invoice.processingFeeAmount || 0,
                      invoice?.currency,
                    )}{" "}
                    is already on this invoice from a prior settlement
                    attempt; no additional fee will be added.
                  </s-text>
                </>
              ) : null}
            </>
          )}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmChargeCard}
          {...(chargeCardSubmitting ? { loading: true } : {})}
        >
          Charge card now
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => chargeCardModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={pauseAutoChargeModalRef}
        id="pause-auto-charge-modal"
        heading="Pause auto-charge for this order?"
        accessibilityLabel="Pause auto-charge confirmation"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The CRON scheduler will stop including this invoice in the
            auto-charge sweep until you resume it. The customer&apos;s
            card on file is not touched, and the rest of the
            practitioner&apos;s orders (and their broader payment
            preference) are unaffected.
          </s-paragraph>
          <s-paragraph tone="subdued">
            Manual settlement (Retry payment, Charge card on file, Mark
            cheque paid) remains available while paused.
          </s-paragraph>
          <s-text-area
            label="Note (optional)"
            placeholder="Reason for pausing — visible in the remarks ledger"
            value={pauseNote}
            rows={3}
            onChange={(e) => setPauseNote(e.currentTarget.value)}
            maxLength={500}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmPauseAutoCharge}
          {...(pauseAutoChargeSubmitting ? { loading: true } : {})}
        >
          Pause auto-charge
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => pauseAutoChargeModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={resumeAutoChargeModalRef}
        id="resume-auto-charge-modal"
        heading="Resume auto-charge for this order?"
        accessibilityLabel="Resume auto-charge confirmation"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This invoice will be included in the CRON auto-charge sweep
            again. The card on file will be charged on the next
            scheduler tick — no charge happens right now.
          </s-paragraph>
          <s-paragraph tone="subdued">
            To charge immediately, use the &quot;Retry payment&quot;
            action instead.
          </s-paragraph>
          <s-text-area
            label="Note (optional)"
            placeholder="Reason for resuming — visible in the remarks ledger"
            value={resumeNote}
            rows={3}
            onChange={(e) => setResumeNote(e.currentTarget.value)}
            maxLength={500}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmResumeAutoCharge}
          {...(resumeAutoChargeSubmitting ? { loading: true } : {})}
        >
          Resume auto-charge
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => resumeAutoChargeModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={pauseRemindersModalRef}
        id="pause-reminders-modal"
        heading="Pause auto email notifications?"
        accessibilityLabel="Pause email reminders confirmation"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The reminder scheduler will stop sending automated payment
            reminder emails (Day 9 / 11 / 13) for this invoice until you
            resume. This affects notifications only — it does not change
            the invoice, the balance, or any payment action.
          </s-paragraph>
          <s-paragraph tone="subdued">
            Reminders resume automatically once you re-enable them; they
            also stop on their own once the invoice is paid.
          </s-paragraph>
          <s-text-area
            label="Note (optional)"
            placeholder="Reason for pausing — visible in the remarks ledger"
            value={reminderPauseNote}
            rows={3}
            onChange={(e) => setReminderPauseNote(e.currentTarget.value)}
            maxLength={500}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmPauseReminders}
          {...(pauseRemindersSubmitting ? { loading: true } : {})}
        >
          Pause notifications
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => pauseRemindersModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={resumeRemindersModalRef}
        id="resume-reminders-modal"
        heading="Resume auto email notifications?"
        accessibilityLabel="Resume email reminders confirmation"
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This invoice will be included in the reminder scheduler again.
            The next CRON run evaluates the Day 9 / 11 / 13 ladder and
            sends any reminder that is now due and not yet sent — no email
            is sent right now.
          </s-paragraph>
          <s-text-area
            label="Note (optional)"
            placeholder="Reason for resuming — visible in the remarks ledger"
            value={reminderResumeNote}
            rows={3}
            onChange={(e) => setReminderResumeNote(e.currentTarget.value)}
            maxLength={500}
          />
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmResumeReminders}
          {...(resumeRemindersSubmitting ? { loading: true } : {})}
        >
          Resume notifications
        </s-button>
        <s-button
          slot="secondary-actions"
          onClick={() => resumeRemindersModalRef.current?.hideOverlay?.()}
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}





function PipelineStepBadge({ step }) {
  return (
    <s-stack direction="block" gap="none" alignItems="center">
      <s-badge tone={PIPELINE_STEP_TONE[step.status] || "default"}>
        {step.label}
      </s-badge>
      {/* nbsp keeps row heights aligned when a step has no subtitle */}
      <s-text tone="subdued">{step.subtitle || " "}</s-text>
    </s-stack>
  );
}

function PipelineConnector() {
  return <s-text tone="subdued">→</s-text>;
}



// Format a QBO "YYYY-MM-DD" due date for display. Returns JSX so we can
// strike through the date once the invoice is settled (or cancelled) —
// the date is no longer an active obligation. Annotates overdue +
// unpaid invoices with a trailing "(overdue)" inline for scanability.
function formatDueDate(qboDueDate, paymentStatus) {
  if (!qboDueDate || typeof qboDueDate !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(qboDueDate);
  if (!m) return qboDueDate;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(due.getTime())) return qboDueDate;
  const label = due.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const settled = paymentStatus === "paid" || paymentStatus === "cancelled";
  if (settled) return <s>{label}</s>;
  if (due < today) return `${label} (overdue)`;
  return label;
}

