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
// fire. 'paid', 'cancelled', and 'in_progress' must be excluded — see
// retry-payment.js / charge-card.js / mark-cheque-paid.js for the same
// guard server-side.
const RETRYABLE_PAYMENT_STATUSES = new Set(["pending", "failed"]);

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
  const failed = paymentStatus === "failed";
  const cancelled = paymentStatus === "cancelled";
  const pending = paymentStatus === "pending";

  const invoiceCreated = !!invoice?.qboInvoiceId;
  const invoiceCreationFailed = invoice?.qboCreationStatus === "failed";
  const orderRejected = order?.processingStatus === "rejected";
  const orderFailed = order?.processingStatus === "failed";
  const completed = order?.processingStatus === "completed";
  const attempts = invoice?.attemptCount ?? 0;
  const isManual =
    invoice?.paymentMethod === "check" || invoice?.paymentMethod === "ach";

  // "Payment processing" subtitle is the most context-loaded — it has
  // to convey retries, in-flight charges, manual-wait, and failures all
  // through one line. Order matters: failed wins over retries.
  let processingSubtitle = null;
  if (failed) {
    processingSubtitle = attempts > 0 ? `Failed after ${attempts}` : "Failed";
  } else if (inProgress) {
    processingSubtitle = "In progress";
  } else if (isManual && pending) {
    processingSubtitle = `Awaiting ${invoice.paymentMethod === "ach" ? "ACH" : "cheque"}`;
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

  const pendingStepStatus = paid || inProgress
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
    : inProgress
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
        .select("qboCustomerId nmiCustomerVaultId profile")
        .lean()
    : null;

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
  const { order, invoice, attempts, customerMap, breakdown, qbo } =
    useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const retryFetcher = useFetcher();
  const chequeFetcher = useFetcher();
  const chargeCardFetcher = useFetcher();
  const pdfFetcher = useFetcher();
  const modalRef = useRef(null);
  const chequeModalRef = useRef(null);
  const chargeCardModalRef = useRef(null);
  const [bannerError, setBannerError] = useState(null);
  const [bannerSuccess, setBannerSuccess] = useState(null);
  const [chequeReference, setChequeReference] = useState("");
  const [chequeAmount, setChequeAmount] = useState("");
  const [chequeReceivedAt, setChequeReceivedAt] = useState("");
  const handledRetryRef = useRef(null);
  const handledChequeRef = useRef(null);
  const handledChargeCardRef = useRef(null);
  const handledPdfRef = useRef(null);
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
  const isManualInvoice = paymentMethod === "check" || paymentMethod === "ach";
  // Immutable preference snapshot taken when this invoice was created.
  // Reads ONLY from customerPaymentPreference — never falls back to
  // paymentMethod (which is mutable via cheque → card override). Legacy
  // invoices missing the snapshot get backfilled at boot from
  // CustomerMap, so this should be set for every real invoice.
  const orderTimePreference = invoice?.customerPaymentPreference || null;
  // Method that actually settled the invoice. For paid invoices, prefer
  // the explicit paymentSettledVia; legacy paid invoices fall back to
  // paymentMethod (which is correct since the override hadn't existed).
  const settledVia =
    invoice?.paymentStatus === "paid"
      ? invoice?.paymentSettledVia || invoice?.paymentMethod || null
      : null;
  const pipelineSteps = computePipelineSteps({ order, invoice });
  const statusAllowsAction =
    !!invoice && RETRYABLE_PAYMENT_STATUSES.has(invoice.paymentStatus);

  const canRetry =
    isCardInvoice &&
    statusAllowsAction &&
    !!customerMap?.nmiCustomerVaultId;
  const canMarkChequePaid = isManualInvoice && statusAllowsAction;
  const canChargeCard =
    isManualInvoice &&
    statusAllowsAction &&
    !!customerMap?.nmiCustomerVaultId;

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

  const outstanding =
    invoice != null
      ? Number((invoice.amountDue - invoice.amountPaid).toFixed(2))
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
      {invoice && isCardInvoice && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!canRetry}
          onClick={() => modalRef.current?.showOverlay?.()}
          {...(retrying ? { loading: true } : {})}
        >
          Retry payment
        </s-button>
      )}
      {invoice && isManualInvoice && (
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
            <ProcessingBadge status={order.processingStatus} />
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
            </s-stack>

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
                    settledVia
                      ? PAYMENT_METHOD_LABEL[settledVia] || settledVia
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

            {invoice && isCardInvoice && !canRetry && (
              <s-paragraph tone="subdued">
                {invoice.paymentStatus === "paid"
                  ? "This invoice is already paid."
                  : invoice.paymentStatus === "cancelled"
                    ? "This invoice has been cancelled."
                    : invoice.paymentStatus === "in_progress"
                      ? "A charge is currently in progress — wait for it to finish."
                      : !customerMap?.nmiCustomerVaultId
                        ? "No NMI vault on file for this customer — collect a payment method before retrying."
                        : null}
              </s-paragraph>
            )}
            {invoice && isManualInvoice && (
              <s-paragraph tone="subdued">
                {invoice.paymentStatus === "paid"
                  ? "This invoice is already paid."
                  : invoice.paymentStatus === "cancelled"
                    ? "This invoice has been cancelled."
                    : invoice.paymentStatus === "in_progress"
                      ? "A charge is currently in progress — wait for it to finish."
                      : `Customer chose ${PAYMENT_METHOD_LABEL[paymentMethod] || paymentMethod}. The scheduler will not auto-charge — record the cheque manually once received, or fall back to charging the card on file.${
                          !customerMap?.nmiCustomerVaultId
                            ? " (Card fallback unavailable — no NMI vault on file.)"
                            : ""
                        }`}
              </s-paragraph>
            )}

            {invoice.manualPayments?.length > 0 && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-text>
                    <strong>Manual payments recorded</strong>
                  </s-text>
                  {invoice.manualPayments.map((mp, i) => (
                    <s-text key={`${mp.reference}-${i}`} tone="subdued">
                      {`${(mp.kind || "cheque").toUpperCase()} ref ${mp.reference} — ${formatAmount(mp.amount, mp.currency || invoice.currency)}${
                        mp.receivedAt
                          ? ` · received ${new Date(mp.receivedAt).toLocaleDateString()}`
                          : ""
                      }${mp.note ? ` · ${mp.note}` : ""}`}
                    </s-text>
                  ))}
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
              <s-button
                variant="secondary"
                onClick={onViewPdf}
                {...(pdfLoading ? { loading: true } : {})}
              >
                View invoice PDF
              </s-button>
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

      <s-modal
        ref={modalRef}
        id="retry-payment-modal"
        heading="Retry payment for this order?"
        accessibilityLabel="Retry payment confirmation"
      >
        <s-paragraph>
          This will charge the customer&apos;s NMI vault for the outstanding balance
          of <strong>{formatAmount(outstanding ?? 0, invoice?.currency)}</strong>{" "}
          right now. If the charge succeeds, the QBO invoice will be marked paid
          and the Shopify order will be flagged paid as well.
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
          card and attempt an NMI sale for{" "}
          <strong>{formatAmount(outstanding ?? 0, invoice?.currency)}</strong>.
          The customer&apos;s default preference will not change for future
          orders.
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

