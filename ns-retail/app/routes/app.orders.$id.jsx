/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { getCdoOrderDetail } from "../services/cdo/cdo.service";
import {
  ensureRetailInvoiceForOrder,
  ensureRetailPaymentForOrder,
  resyncInvoiceShippingForOrder,
  sendRetailInvoiceForOrder,
  getRetailInvoicePdf,
} from "../services/retailQbo/retailOrderInvoice.service";
import StatusBadge from "../components/cdo/StatusBadge";
import { ShippingBadge, DeliveryBadge } from "../components/cdo/StatusBadges";
import { formatCurrency, formatDate, formatDateTime, formatPercent } from "../utils/format";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const order = await getCdoOrderDetail(params.id);
  if (!order) throw new Response("Order not found", { status: 404 });
  return { order };
};

// Manual QBO actions for an existing order — create/retry the retail invoice
// and re-sync shipping. Used to (re)create an invoice for orders placed before
// the auto-flow existed, or to retry after fixing credentials / the item id.
// Surfaces the real QBO error so failures are debuggable instead of silent.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const op = String(form.get("_action") || "");
  const shopifyOrderId = String(form.get("shopifyOrderId") || "");
  if (!shopifyOrderId) return { status: "error", message: "Missing Shopify order id." };
  const shop = session.shop;

  try {
    if (op === "create-invoice") {
      const r = await ensureRetailInvoiceForOrder({ shop, shopifyOrderId, force: true });
      if (r.ok && (r.invoiceId || r.reason === "already_invoiced")) {
        return { status: "success", message: `QBO invoice ${r.invoiceId || ""} ready.`.trim() };
      }
      if (r.reason === "not_configured") {
        return {
          status: "error",
          message:
            "Retail QBO is not configured. Set CDO_QBO_Retail_CLIENT_ID / CLIENT_SECRET / REALM_ID / REFRESH_TOKEN and restart the server.",
        };
      }
      if (r.reason === "order_not_found") {
        return { status: "error", message: "Order not found in this shop." };
      }
      return {
        status: "error",
        message: r.error || "Invoice was not created — see QBO sync history below for the reason.",
      };
    }
    if (op === "record-payment") {
      const r = await ensureRetailPaymentForOrder({ shop, shopifyOrderId });
      if (r.ok && (r.paymentId || r.reason === "invoice_already_settled")) {
        return { status: "success", message: `Payment recorded — invoice marked Paid in QBO.` };
      }
      if (r.reason === "already_paid") {
        return { status: "success", message: `Invoice already has a QBO payment (${r.paymentId}).` };
      }
      if (r.reason === "no_invoice") {
        return { status: "error", message: "Create the QBO invoice first, then record the payment." };
      }
      if (r.reason === "not_paid") {
        return { status: "error", message: "The Shopify order isn't paid yet — payment recorded only for paid orders." };
      }
      if (r.reason === "payment_disabled") {
        return { status: "error", message: "Payment recording is disabled (CDO_QBO_Retail_RECORD_PAYMENT=false)." };
      }
      if (r.reason === "not_configured") {
        return { status: "error", message: "Retail QBO is not configured." };
      }
      return { status: "error", message: r.error || "Could not record the payment in QBO." };
    }
    if (op === "resync-shipping") {
      const r = await resyncInvoiceShippingForOrder({ shop, shopifyOrderId });
      if (r.ok && r.synced) return { status: "success", message: "Shipping re-synced to the QBO invoice." };
      if (r.reason === "no_invoice") {
        return { status: "error", message: "Create the QBO invoice first, then re-sync shipping." };
      }
      return { status: "error", message: r.error || "Nothing to sync yet." };
    }
    if (op === "send-invoice") {
      const r = await sendRetailInvoiceForOrder({ shop, shopifyOrderId });
      if (r.ok) return { status: "success", message: `Invoice emailed to ${r.email}.` };
      if (r.reason === "no_invoice") {
        return { status: "error", message: "Create the QBO invoice first, then send it." };
      }
      if (r.reason === "no_email") {
        return { status: "error", message: "This order has no customer email to send the invoice to." };
      }
      return { status: "error", message: r.error || "Could not send the invoice." };
    }
    if (op === "invoice-pdf") {
      const r = await getRetailInvoicePdf({ shop, shopifyOrderId });
      if (r.ok) {
        return {
          status: "success",
          op: "invoice-pdf",
          base64: r.base64,
          contentType: r.contentType,
          filename: r.filename,
        };
      }
      if (r.reason === "no_invoice") {
        return { status: "error", op: "invoice-pdf", message: "Create the QBO invoice first, then preview it." };
      }
      return { status: "error", op: "invoice-pdf", message: r.error || "Could not load the invoice PDF." };
    }
    return { status: "error", message: "Unknown action." };
  } catch (e) {
    return { status: "error", message: e?.message || "Action failed." };
  }
};

function Row({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value ?? "—"}</s-text>
    </s-stack>
  );
}

function AddressBlock({ label, a }) {
  const lines = a
    ? [a.name, a.line1, a.line2, [a.city, a.province, a.zip].filter(Boolean).join(" "), a.country, a.phone].filter(
        Boolean,
      )
    : [];
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      {lines.length ? (
        lines.map((l, i) => <s-text key={i}>{l}</s-text>)
      ) : (
        <s-text>—</s-text>
      )}
    </s-stack>
  );
}

// QBO invoice sync status → Polaris badge tone.
function QboStatusBadge({ status }) {
  if (!status) return <s-badge tone="neutral">Not created</s-badge>;
  const map = {
    created: { tone: "success", label: "Created" },
    shipping_synced: { tone: "success", label: "Created · shipping synced" },
    creating: { tone: "info", label: "Creating…" },
    pending: { tone: "neutral", label: "Pending" },
    error: { tone: "critical", label: "Error" },
  };
  const m = map[status] || { tone: "neutral", label: status };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

export default function OrderDetail() {
  const { order } = useLoaderData();
  const navigate = useNavigate();
  const qboFetcher = useFetcher();
  const qboBusy = qboFetcher.state !== "idle";
  const pdfFetcher = useFetcher();
  const pdfLoading = pdfFetcher.state !== "idle";
  // Window opened synchronously on click (popup-blocker-safe) + a guard so the
  // auto-revalidation after a fetcher action doesn't re-open the PDF.
  const pdfWindowRef = useRef(null);
  const handledPdfRef = useRef(null);
  const cur = order.currency;
  const p = order.pricing || {};
  const q = order.retailQbo;
  const fulfillments = order.fulfillments || [];
  const firstTxn = order.transactions?.[0] || null;
  const paymentMethod =
    (order.payment?.gateways || []).join(", ") || firstTxn?.gateway || "—";

  // "Preview invoice" — open the QBO-rendered invoice PDF. The window must be
  // opened SYNCHRONOUSLY in the click handler (user gesture) to survive popup
  // blockers; the server returns the PDF base64 and we swap in a blob URL.
  const onViewPdf = () => {
    pdfWindowRef.current = window.open("about:blank", "_blank");
    pdfFetcher.submit(
      { _action: "invoice-pdf", shopifyOrderId: order.shopifyOrderId || "" },
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
        // Popup blocked — fall back to a download.
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

  return (
    <s-stack direction="block" gap="base">
      <s-box paddingBlockEnd="base">
        <s-button variant="tertiary" icon="arrow-left" onClick={() => navigate("/app/orders")}>
          Back to Orders
        </s-button>
      </s-box>

      <s-section heading={order.orderName}>
        <s-stack direction="inline" gap="large" alignItems="center">
          <StatusBadge status={order.status} />
          {order.attributed ? <s-badge tone="success">Attributed</s-badge> : <s-badge tone="neutral">Retail</s-badge>}
          <QboStatusBadge status={q?.qboSyncStatus} />
          <Row label="Total" value={formatCurrency(order.amount, cur)} />
          <Row label="Placed" value={formatDateTime(order.placedAt)} />
          <Row label="Payment" value={order.financialStatus || "—"} />
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Shipping</s-text>
            <ShippingBadge status={order.shippingStatus} />
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Delivery</s-text>
            <DeliveryBadge status={order.deliveryStatus} />
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Order information ── */}
      <s-section heading="Order information">
        <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
          <Row label="Order number" value={order.orderNumber || order.orderName} />
          <Row label="Order date" value={formatDateTime(order.placedAt)} />
          <Row label="Order status" value={order.status} />
          <Row label="Financial status" value={order.financialStatus} />
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Shipping status</s-text>
            <ShippingBadge status={order.shippingStatus} />
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Delivery status</s-text>
            <DeliveryBadge status={order.deliveryStatus} />
          </s-stack>
          <Row label="Source channel" value={order.sourceName} />
        </s-grid>
        <s-box paddingBlockStart="base">
          <s-stack direction="block" gap="tight">
            <s-stack direction="block" gap="none">
              <s-text tone="subdued">Order tags</s-text>
              {order.tags?.length ? (
                <s-stack direction="inline" gap="small-200">
                  {order.tags.map((t) => (
                    <s-badge key={t} tone="neutral">
                      {t}
                    </s-badge>
                  ))}
                </s-stack>
              ) : (
                <s-text>—</s-text>
              )}
            </s-stack>
            <Row label="Order notes" value={order.note} />
            {order.noteAttributes?.length > 0 &&
              order.noteAttributes.map((a, i) => <Row key={i} label={a.name || "—"} value={a.value || "—"} />)}
          </s-stack>
        </s-box>
      </s-section>

      {/* ── Customer ── */}
      <s-grid gap="base" gridTemplateColumns="repeat(2, minmax(0, 1fr))">
        <s-section heading="Customer information">
          <s-stack direction="block" gap="tight">
            <Row label="Name" value={order.customer.name} />
            <Row label="Email" value={order.customer.email} />
            <Row label="Phone" value={order.customer.phone} />
            <AddressBlock label="Billing address" a={order.billingAddress} />
            <AddressBlock label="Shipping address" a={order.shippingAddress} />
          </s-stack>
        </s-section>

        <s-section heading="Referral & practitioner">
          {order.attributed ? (
            <s-stack direction="block" gap="tight">
              <Row label="Referral code" value={order.referralCode} />
              <Row label="Practitioner" value={order.practitioner?.name || order.practitioner?.email} />
              <Row label="Practitioner email" value={order.practitioner?.email} />
              <Row
                label="Commission rate"
                value={order.referral?.commissionRate != null ? formatPercent(order.referral.commissionRate) : "—"}
              />
              <Row
                label="Attribution source"
                value={order.attribution?.source ? `${order.attribution.source} (${order.attribution.code || "—"})` : "—"}
              />
            </s-stack>
          ) : (
            <s-paragraph tone="subdued">This order carried no (valid) referral code — standard retail order.</s-paragraph>
          )}
        </s-section>
      </s-grid>

      {/* ── Products ── */}
      <s-section heading={`Product information (${order.lineItems.length})`}>
        {order.lineItems.length === 0 ? (
          <s-paragraph tone="subdued">No line items recorded.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Variant</s-table-header>
              <s-table-header>Qty</s-table-header>
              <s-table-header>Unit price</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Total</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {order.lineItems.map((li, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{li.title || "—"}</s-table-cell>
                  <s-table-cell>{li.sku || "—"}</s-table-cell>
                  <s-table-cell>{li.variantTitle || "—"}</s-table-cell>
                  <s-table-cell>{li.quantity}</s-table-cell>
                  <s-table-cell>{formatCurrency(li.price, cur)}</s-table-cell>
                  <s-table-cell>
                    {li.totalDiscount > 0 ? `− ${formatCurrency(li.totalDiscount, cur)}` : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {formatCurrency((Number(li.price) || 0) * (Number(li.quantity) || 0) - (Number(li.totalDiscount) || 0), cur)}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* ── Pricing / tax / discount ── */}
      <s-grid gap="base" gridTemplateColumns="repeat(2, minmax(0, 1fr))">
        <s-section heading="Pricing">
          <s-stack direction="block" gap="tight">
            <Row label="Subtotal" value={formatCurrency(p.subtotal, cur)} />
            <Row label="Discounts" value={formatCurrency(p.totalDiscounts, cur)} />
            <Row label="Tax" value={formatCurrency(p.totalTax, cur)} />
            <Row label="Shipping" value={formatCurrency(p.totalShipping, cur)} />
            <Row label="Total" value={formatCurrency(p.total ?? order.amount, cur)} />
            {order.discountCodes.length > 0 ? (
              <Row label="Discount codes" value={order.discountCodes.map((d) => d.code).join(", ")} />
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="Tax & discount details">
          <s-stack direction="block" gap="tight">
            {order.taxLines?.length ? (
              order.taxLines.map((t, i) => (
                <Row
                  key={i}
                  label={`${t.title || "Tax"}${t.rate != null ? ` (${formatPercent(t.rate)})` : ""}`}
                  value={formatCurrency(t.price, cur)}
                />
              ))
            ) : (
              <Row label="Tax" value={formatCurrency(p.totalTax, cur)} />
            )}
            {order.discountCodes?.length ? (
              order.discountCodes.map((d, i) => (
                <Row key={`d${i}`} label={`Discount: ${d.code || "—"}`} value={formatCurrency(d.amount, cur)} />
              ))
            ) : (
              <Row label="Discounts" value={formatCurrency(p.totalDiscounts, cur)} />
            )}
          </s-stack>
        </s-section>
      </s-grid>

      {/* ── Shipping & fulfillment ── */}
      <s-section heading="Shipping & fulfillment">
        <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Shipping status</s-text>
            <ShippingBadge status={order.shippingStatus} />
          </s-stack>
          <s-stack direction="block" gap="none">
            <s-text tone="subdued">Delivery status</s-text>
            <DeliveryBadge status={order.deliveryStatus} />
          </s-stack>
          <Row label="Ship date" value={order.shippedAt ? formatDate(order.shippedAt) : "—"} />
          <Row
            label="Shipping method"
            value={(order.shippingLines || []).map((s) => s.title).filter(Boolean).join(", ") || "—"}
          />
          <Row label="Shipping charges" value={formatCurrency(p.totalShipping, cur)} />
        </s-grid>
        <s-box paddingBlockStart="base">
          {fulfillments.length === 0 ? (
            <s-paragraph tone="subdued">
              No fulfillments yet. Carrier, tracking number and shipment status appear here once the order ships in
              Shopify.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Carrier</s-table-header>
                <s-table-header>Tracking number</s-table-header>
                <s-table-header>Tracking URL</s-table-header>
                <s-table-header>Shipment status</s-table-header>
                <s-table-header>Fulfillment date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {fulfillments.map((f, i) => (
                  <s-table-row key={i}>
                    <s-table-cell>{f.trackingCompany || "—"}</s-table-cell>
                    <s-table-cell>
                      {f.trackingNumber ? (
                        f.trackingUrl ? (
                          <s-link href={f.trackingUrl} target="_blank">
                            {f.trackingNumber} ↗
                          </s-link>
                        ) : (
                          f.trackingNumber
                        )
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {f.trackingUrl ? (
                        <s-link href={f.trackingUrl} target="_blank">
                          Track ↗
                        </s-link>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                    <s-table-cell>{f.shipmentStatus || f.status || "—"}</s-table-cell>
                    <s-table-cell>{f.fulfilledAt ? formatDate(f.fulfilledAt) : "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-box>
      </s-section>

      {/* ── Payment information ── */}
      <s-section heading="Payment information">
        <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
          <Row label="Payment method" value={paymentMethod} />
          <Row label="Transaction ID" value={firstTxn?.id} />
          <Row label="Payment status" value={order.financialStatus} />
          <Row label="Total amount" value={formatCurrency(order.amount, cur)} />
          <Row label="Tax amount" value={formatCurrency(p.totalTax, cur)} />
          <Row label="Discount amount" value={formatCurrency(p.totalDiscounts, cur)} />
          <Row label="Shipping amount" value={formatCurrency(p.totalShipping, cur)} />
        </s-grid>
      </s-section>

      {/* ── QuickBooks information ── */}
      <s-section heading="QuickBooks information">
        <s-stack direction="block" gap="base">
          {qboFetcher.data ? (
            <s-banner
              tone={qboFetcher.data.status === "success" ? "success" : "critical"}
              heading={qboFetcher.data.status === "success" ? "Done" : "Could not complete"}
            >
              <s-paragraph>{qboFetcher.data.message}</s-paragraph>
            </s-banner>
          ) : null}

          {pdfFetcher.data?.op === "invoice-pdf" && pdfFetcher.data.status === "error" ? (
            <s-banner tone="critical" heading="Could not open invoice PDF">
              <s-paragraph>{pdfFetcher.data.message}</s-paragraph>
            </s-banner>
          ) : null}

          {!q || !q.qboInvoiceId ? (
            <s-paragraph tone="subdued">
              No QBO invoice yet. New retail orders are invoiced automatically on placement; for this order use
              “Create QBO invoice” below.
            </s-paragraph>
          ) : (
            <s-grid gap="base" gridTemplateColumns="repeat(3, minmax(0, 1fr))">
              <Row label="QBO customer ID" value={q.qboCustomerId} />
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">QBO invoice ID</s-text>
                {q.invoiceUrl ? (
                  <s-link href={q.invoiceUrl} target="_blank">
                    {q.qboInvoiceId} ↗
                  </s-link>
                ) : (
                  <s-text>{q.qboInvoiceId}</s-text>
                )}
              </s-stack>
              <Row label="Invoice number" value={q.qboInvoiceDocNumber} />
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Invoice status</s-text>
                <QboStatusBadge status={q?.qboSyncStatus} />
              </s-stack>
              <Row label="Invoice created" value={q.qboCreatedAt ? formatDateTime(q.qboCreatedAt) : "—"} />
              <Row label="Last sync" value={q.qboSyncedAt ? formatDateTime(q.qboSyncedAt) : "—"} />
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Invoice sent</s-text>
                {q.invoiceSentAt ? (
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone="success">Sent</s-badge>
                    <s-text>
                      {formatDateTime(q.invoiceSentAt)}
                      {q.invoiceEmailedTo ? ` · ${q.invoiceEmailedTo}` : ""}
                    </s-text>
                  </s-stack>
                ) : (
                  <s-badge tone="neutral">Not sent</s-badge>
                )}
              </s-stack>
              <Row label="Email status" value={q.invoiceEmailStatus} />
              <Row
                label="Customer notified (shipment)"
                value={q.lastShipmentNotifiedAt ? formatDateTime(q.lastShipmentNotifiedAt) : "—"}
              />
              {/* ── Payment (invoice marked Paid in QBO) ── */}
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Invoice payment</s-text>
                {q.qboPaymentId || q.invoiceStatus === "paid" ? (
                  <s-badge tone="success">Paid in QBO</s-badge>
                ) : q.paymentSyncStatus === "error" ? (
                  <s-badge tone="critical">Payment error</s-badge>
                ) : q.paymentSyncStatus === "creating" ? (
                  <s-badge tone="info">Recording…</s-badge>
                ) : (
                  <s-badge tone="neutral">Not paid</s-badge>
                )}
              </s-stack>
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">QBO payment ID</s-text>
                {q.qboPaymentId ? (
                  q.qboPaymentUrl ? (
                    <s-link href={q.qboPaymentUrl} target="_blank">
                      {q.qboPaymentId} ↗
                    </s-link>
                  ) : (
                    <s-text>{q.qboPaymentId}</s-text>
                  )
                ) : (
                  <s-text>—</s-text>
                )}
              </s-stack>
              <Row label="Payment reference #" value={q.qboPaymentRefNum} />
              <Row label="Shopify transaction ID" value={q.shopifyTransactionId} />
              <Row label="Payment gateway" value={q.shopifyPaymentGateway} />
              <Row
                label="Payment amount"
                value={q.qboPaymentTotal != null ? formatCurrency(q.qboPaymentTotal, cur) : "—"}
              />
              <Row
                label="Payment recorded"
                value={q.paymentAppliedAt ? formatDateTime(q.paymentAppliedAt) : "—"}
              />
            </s-grid>
          )}

          {q?.qboSyncError ? (
            <s-banner tone="critical" heading="Last QBO sync error">
              <s-paragraph>{q.qboSyncError}</s-paragraph>
            </s-banner>
          ) : null}

          {q?.paymentSyncError ? (
            <s-banner tone="critical" heading="Last QBO payment error">
              <s-paragraph>{q.paymentSyncError}</s-paragraph>
            </s-banner>
          ) : null}

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button
              variant="primary"
              disabled={qboBusy}
              onClick={() =>
                qboFetcher.submit(
                  { _action: "create-invoice", shopifyOrderId: order.shopifyOrderId || "" },
                  { method: "POST" },
                )
              }
            >
              {q?.qboInvoiceId ? "Re-create / retry invoice" : "Create QBO invoice"}
            </s-button>
            {q?.qboInvoiceId ? (
              <>
                <s-button disabled={pdfLoading} onClick={onViewPdf}>
                  Preview invoice
                </s-button>
                <s-button
                  disabled={qboBusy}
                  onClick={() =>
                    qboFetcher.submit(
                      { _action: "send-invoice", shopifyOrderId: order.shopifyOrderId || "" },
                      { method: "POST" },
                    )
                  }
                >
                  Send invoice
                </s-button>
                <s-button
                  disabled={qboBusy}
                  onClick={() =>
                    qboFetcher.submit(
                      { _action: "resync-shipping", shopifyOrderId: order.shopifyOrderId || "" },
                      { method: "POST" },
                    )
                  }
                >
                  Re-sync shipping
                </s-button>
                {!q.qboPaymentId && q.invoiceStatus !== "paid" ? (
                  <s-button
                    disabled={qboBusy}
                    onClick={() =>
                      qboFetcher.submit(
                        { _action: "record-payment", shopifyOrderId: order.shopifyOrderId || "" },
                        { method: "POST" },
                      )
                    }
                  >
                    Record payment
                  </s-button>
                ) : null}
              </>
            ) : null}
            {qboBusy || pdfLoading ? <s-text tone="subdued">Working…</s-text> : null}
          </s-stack>
        </s-stack>
      </s-section>

      {/* ── Commission (CDO) ── */}
      <s-section heading="Commission">
        {order.commissions.length === 0 ? (
          <s-paragraph tone="subdued">
            {order.attributed
              ? `Commission amount ${formatCurrency(order.commissionAmount, cur)} — no commission record created yet.`
              : "No commission (unattributed order)."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Rate</s-table-header>
              <s-table-header>Accrual status</s-table-header>
              <s-table-header>Payout status</s-table-header>
              <s-table-header>Payout date</s-table-header>
              <s-table-header>Txn ref</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {order.commissions.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>{formatCurrency(c.amount, cur)}</s-table-cell>
                  <s-table-cell>{formatPercent(c.rate)}</s-table-cell>
                  <s-table-cell><StatusBadge status={c.status} /></s-table-cell>
                  <s-table-cell>{c.payoutStatus ? <StatusBadge status={c.payoutStatus} /> : "—"}</s-table-cell>
                  <s-table-cell>{c.payoutDate ? formatDateTime(c.payoutDate) : "—"}</s-table-cell>
                  <s-table-cell>{c.payoutTxnRef || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {/* ── Audit & activity ── */}
      <s-section heading="Order timeline">
        <s-stack direction="block" gap="tight">
          {order.timeline.map((t, i) => (
            <Row key={i} label={t.label} value={formatDateTime(t.at)} />
          ))}
          <Row label="Shopify order id" value={order.shopifyOrderId} />
        </s-stack>
      </s-section>

      <s-grid gap="base" gridTemplateColumns="repeat(2, minmax(0, 1fr))">
        <s-section heading="QBO sync history">
          {q?.syncLog?.length ? (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Event</s-table-header>
                <s-table-header>Result</s-table-header>
                <s-table-header>Message</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...q.syncLog]
                  .sort((a, b) => String(b.at).localeCompare(String(a.at)))
                  .map((s, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>{formatDateTime(s.at)}</s-table-cell>
                      <s-table-cell>{s.event || "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={s.ok ? "success" : "critical"}>{s.ok ? "OK" : "Error"}</s-badge>
                      </s-table-cell>
                      <s-table-cell>{s.message || "—"}</s-table-cell>
                    </s-table-row>
                  ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph tone="subdued">No QBO sync activity yet.</s-paragraph>
          )}
        </s-section>

        <s-section heading="Shipment update history">
          {order.trackingHistory?.length ? (
            <s-table>
              <s-table-header-row>
                <s-table-header>When</s-table-header>
                <s-table-header>Carrier</s-table-header>
                <s-table-header>Number</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Event</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...order.trackingHistory]
                  .sort((a, b) => String(b.at).localeCompare(String(a.at)))
                  .map((h, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>{formatDateTime(h.at)}</s-table-cell>
                      <s-table-cell>{h.trackingCompany || "—"}</s-table-cell>
                      <s-table-cell>{h.trackingNumber || "—"}</s-table-cell>
                      <s-table-cell>{h.shipmentStatus || "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={h.event === "created" ? "info" : "neutral"}>
                          {h.event === "created" ? "Added" : "Updated"}
                        </s-badge>
                      </s-table-cell>
                    </s-table-row>
                  ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph tone="subdued">No shipment updates yet.</s-paragraph>
          )}
        </s-section>
      </s-grid>
    </s-stack>
  );
}
