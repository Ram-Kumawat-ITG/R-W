/* eslint-disable react/prop-types */
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { getCdoOrderDetail } from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDateTime, formatPercent } from "../utils/format";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const order = await getCdoOrderDetail(params.id);
  if (!order) throw new Response("Order not found", { status: 404 });
  return { order };
};

function Row({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value ?? "—"}</s-text>
    </s-stack>
  );
}

function addr(a) {
  if (!a) return "—";
  return [a.name, a.line1, a.line2, [a.city, a.province, a.zip].filter(Boolean).join(" "), a.country]
    .filter(Boolean)
    .join(", ");
}

export default function OrderDetail() {
  const { order } = useLoaderData();
  const navigate = useNavigate();
  const cur = order.currency;
  const p = order.pricing || {};

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
          <Row label="Total" value={formatCurrency(order.amount, cur)} />
          <Row label="Placed" value={formatDateTime(order.placedAt)} />
          <Row label="Payment" value={order.financialStatus || "—"} />
          <Row label="Fulfillment" value={order.fulfillmentStatus || "—"} />
        </s-stack>
      </s-section>

      <s-grid gap="base" gridTemplateColumns="repeat(2, minmax(0, 1fr))">
        <s-section heading="Customer">
          <s-stack direction="block" gap="tight">
            <Row label="Name" value={order.customer.name} />
            <Row label="Email" value={order.customer.email} />
            <Row label="Phone" value={order.customer.phone} />
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

      <s-section heading={`Products (${order.lineItems.length})`}>
        {order.lineItems.length === 0 ? (
          <s-paragraph tone="subdued">No line items recorded.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Item</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Qty</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Discount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {order.lineItems.map((li, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{[li.title, li.variantTitle].filter(Boolean).join(" · ") || "—"}</s-table-cell>
                  <s-table-cell>{li.sku || "—"}</s-table-cell>
                  <s-table-cell>{li.quantity}</s-table-cell>
                  <s-table-cell>{formatCurrency(li.price, cur)}</s-table-cell>
                  <s-table-cell>{formatCurrency(li.totalDiscount, cur)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

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

        <s-section heading="Payment & shipping">
          <s-stack direction="block" gap="tight">
            <Row label="Payment status" value={order.financialStatus} />
            <Row label="Gateways" value={(order.payment?.gateways || []).join(", ") || "—"} />
            <Row label="Billing address" value={addr(order.billingAddress)} />
            <Row label="Shipping address" value={addr(order.shippingAddress)} />
          </s-stack>
        </s-section>
      </s-grid>

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

      <s-section heading="Timeline & audit">
        <s-stack direction="block" gap="tight">
          {order.timeline.map((t, i) => (
            <Row key={i} label={t.label} value={formatDateTime(t.at)} />
          ))}
          <Row label="Shopify order id" value={order.shopifyOrderId} />
        </s-stack>
      </s-section>
    </s-stack>
  );
}
