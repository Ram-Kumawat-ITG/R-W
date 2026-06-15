// Retail QBO domain methods — the accounts-receivable ("money in") side:
// retail customer → QBO Customer, retail order → QBO Invoice, shipment
// tracking → invoice sync. All HTTP goes through retailQbo.apis.js (the
// retail realm). Independent of the CDO payouts service (services/qbo/*).

import { retailQbo, qboRetailRequest, qboRetailGetBinary } from "./retailQbo.apis";
import { retailQboConfig } from "./retailQbo.config";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("retail.qbo.service");

// QBO QL escapes a single quote inside a string literal with a backslash.
function escapeQuery(value) {
  return String(value ?? "").replace(/'/g, "\\'");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// QBO date fields are date-only (YYYY-MM-DD).
function toQboDate(d) {
  if (!d) return undefined;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

// ── Customers ────────────────────────────────────────────────────────

// QBO Customer DisplayName must be unique across the customer list. We use
// the buyer's email as the DisplayName when present (stable + unique per
// person), falling back to their name. Find-or-create is idempotent: repeat
// orders from the same buyer resolve to the same Customer (no duplicates).
async function queryCustomerByDisplayName(displayName) {
  if (!displayName) return null;
  const res = await retailQbo.query(
    `SELECT * FROM Customer WHERE DisplayName = '${escapeQuery(displayName)}'`,
  );
  return res?.QueryResponse?.Customer?.[0] || null;
}

function mapQboAddr(a) {
  if (!a) return undefined;
  const line1 = a.line1 || a.address1;
  const out = {
    ...(line1 ? { Line1: String(line1) } : {}),
    ...(a.line2 || a.address2 ? { Line2: String(a.line2 || a.address2) } : {}),
    ...(a.city ? { City: String(a.city) } : {}),
    ...(a.province ? { CountrySubDivisionCode: String(a.province) } : {}),
    ...(a.zip ? { PostalCode: String(a.zip) } : {}),
    ...(a.country ? { Country: String(a.country) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export async function findOrCreateCustomer({
  email,
  firstName,
  lastName,
  name,
  phone,
  billingAddress,
  shippingAddress,
}) {
  const displayName = (email || name || "").trim();
  if (!displayName) {
    throw new Error("findOrCreateCustomer: an email or name is required");
  }

  // 1) Adopt an existing customer with this DisplayName.
  let customer = await queryCustomerByDisplayName(displayName);

  // 2) Otherwise create. A 6240 (duplicate name) means one already exists —
  //    adopt it.
  if (!customer) {
    const billAddr = mapQboAddr(billingAddress);
    const shipAddr = mapQboAddr(shippingAddress);
    const payload = {
      DisplayName: displayName.slice(0, 100),
      ...(firstName ? { GivenName: String(firstName).slice(0, 100) } : {}),
      ...(lastName ? { FamilyName: String(lastName).slice(0, 100) } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
      ...(phone ? { PrimaryPhone: { FreeFormNumber: String(phone) } } : {}),
      ...(billAddr ? { BillAddr: billAddr } : {}),
      ...(shipAddr ? { ShipAddr: shipAddr } : {}),
    };
    try {
      const created = await retailQbo.post("/customer", payload);
      customer = created?.Customer || null;
    } catch (err) {
      const code = err?.body?.Fault?.Error?.[0]?.code;
      if (code === "6240" || /duplicate/i.test(err?.message || "")) {
        customer = await queryCustomerByDisplayName(displayName);
      }
      if (!customer) throw err;
    }
  }

  if (!customer?.Id) {
    throw new Error(`Retail QBO: failed to resolve a customer for "${displayName}"`);
  }
  log.info("customer.resolved", { displayName, qboCustomerId: customer.Id });
  return { id: String(customer.Id), displayName: customer.DisplayName || displayName };
}

// ── Sales item (single, per the locked decision) ─────────────────────

// Module-memoized so we resolve the income/sales item once per process.
let _salesItemId = null;

// Resolve the income account to attach a freshly-created Service item to:
// explicit override → reuse an existing item's income account → first Income
// account in the chart of accounts.
async function resolveIncomeAccountRef() {
  if (retailQboConfig.incomeAccountId) {
    return { value: String(retailQboConfig.incomeAccountId) };
  }
  const itemRes = await retailQbo.query(
    "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1",
  );
  const existing = itemRes?.QueryResponse?.Item?.[0];
  if (existing?.IncomeAccountRef?.value) {
    return { value: String(existing.IncomeAccountRef.value) };
  }
  const acctRes = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1",
  );
  const acct = acctRes?.QueryResponse?.Account?.[0];
  if (acct?.Id) return { value: String(acct.Id) };
  throw new Error(
    "Retail QBO: no Income account found to back the sales item. " +
      "Set QBO_RETAIL_INCOME_ACCOUNT_ID or QBO_RETAIL_ITEM_ID.",
  );
}

// Resolve the single QBO Item every retail invoice line posts to:
//   1. QBO_RETAIL_ITEM_ID override (verbatim)
//   2. an existing item named QBO_RETAIL_ITEM_NAME
//   3. any existing Service item (simplest — avoids a create + account lookup)
//   4. create the named Service item against a resolved Income account
export async function resolveSalesItemId() {
  if (_salesItemId) return _salesItemId;
  if (retailQboConfig.salesItemId) {
    _salesItemId = String(retailQboConfig.salesItemId);
    return _salesItemId;
  }

  const wantName = retailQboConfig.salesItemName;
  const byName = await retailQbo.query(
    `SELECT * FROM Item WHERE Name = '${escapeQuery(wantName)}'`,
  );
  const named = byName?.QueryResponse?.Item?.[0];
  if (named?.Id) {
    _salesItemId = String(named.Id);
    return _salesItemId;
  }

  const anyService = await retailQbo.query(
    "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 1",
  );
  const svc = anyService?.QueryResponse?.Item?.[0];
  if (svc?.Id) {
    _salesItemId = String(svc.Id);
    return _salesItemId;
  }

  const incomeRef = await resolveIncomeAccountRef();
  const created = await retailQbo.post("/item", {
    Name: wantName,
    Type: "Service",
    IncomeAccountRef: incomeRef,
  });
  const item = created?.Item;
  if (!item?.Id) throw new Error("Retail QBO: failed to create the sales item");
  _salesItemId = String(item.Id);
  log.info("sales_item.created", { itemId: _salesItemId, name: wantName });
  return _salesItemId;
}

// ── Invoices ─────────────────────────────────────────────────────────

// Build the QBO Invoice payload from a cdo_orders snapshot. Every product +
// shipping line posts to the single sales item (NON tax code — Shopify's tax
// total is carried via TxnTaxDetail). A DiscountLine applies order discounts,
// and a reconciling Adjustment line guarantees the QBO TotalAmt equals the
// Shopify order total.
function buildInvoiceLines({ order, itemId }) {
  const lines = [];
  let productSum = 0;
  for (const li of order.lineItems || []) {
    const qty = Number(li.quantity) || 0;
    const unit = round2(li.price);
    const amount = round2(qty * unit);
    productSum += amount;
    const descParts = [li.title, li.variantTitle].filter(Boolean).join(" · ");
    const desc = [descParts, li.sku ? `SKU: ${li.sku}` : null].filter(Boolean).join(" — ");
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: amount,
      ...(desc ? { Description: desc.slice(0, 4000) } : {}),
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: qty,
        UnitPrice: unit,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  const p = order.pricing || {};
  const shipping = round2(p.totalShipping);
  if (shipping > 0) {
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: shipping,
      Description: "Shipping",
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: shipping,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  const discount = round2(p.totalDiscounts);
  if (discount > 0) {
    lines.push({
      DetailType: "DiscountLineDetail",
      Amount: discount,
      DiscountLineDetail: { PercentBased: false },
    });
  }

  const tax = round2(p.totalTax);
  const expected = round2(order.amount ?? p.total);
  // QBO TotalAmt = sum(SalesItem lines) - discount + TxnTaxDetail.TotalTax.
  const computed = round2(productSum + shipping - discount + tax);
  const adjustment = round2(expected - computed);
  if (Math.abs(adjustment) > 0.005) {
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: adjustment,
      Description: "Adjustment",
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: 1,
        UnitPrice: adjustment,
        TaxCodeRef: { value: "NON" },
      },
    });
  }

  return { lines, tax };
}

// Create the QBO Invoice for a cdo_orders snapshot. Idempotent at the QBO
// layer via `requestid` (a retry that committed server-side returns the
// original). Returns the created Invoice.
export async function createInvoiceForOrder({ order, customerId, itemId, requestId }) {
  if (!customerId) throw new Error("createInvoiceForOrder: customerId is required");
  if (!itemId) throw new Error("createInvoiceForOrder: itemId is required");

  const { lines, tax } = buildInvoiceLines({ order, itemId });
  if (lines.length === 0) {
    throw new Error("createInvoiceForOrder: order has no line items to invoice");
  }

  const email = order.customerEmail || order.customer?.email || null;
  const payload = {
    CustomerRef: { value: String(customerId) },
    Line: lines,
    ...(tax > 0 ? { TxnTaxDetail: { TotalTax: tax } } : {}),
    ...(order.placedAt ? { TxnDate: toQboDate(order.placedAt) } : {}),
    ...(email ? { BillEmail: { Address: email } } : {}),
    CustomerMemo: {
      value: `Retail order ${order.orderName || order.shopifyOrderId || ""}`.trim().slice(0, 1000),
    },
    ...(order.currency ? { CurrencyRef: { value: order.currency } } : {}),
  };

  // QBO caps requestid at 50 chars; order.shopifyOrderId is the full GID, so
  // fall back to its short numeric tail (stable + unique per order).
  const shortOrderId = String(order.shopifyOrderId || "").split("/").pop() || "x";
  const res = await retailQbo.post("/invoice", payload, undefined, {
    requestId: (requestId || `retail-inv-${shortOrderId}`).slice(0, 50),
  });
  const invoice = res?.Invoice;
  if (!invoice?.Id) throw new Error("createInvoiceForOrder: QBO did not return an Invoice id");
  log.info("invoice.created", {
    shopifyOrderId: order.shopifyOrderId,
    invoiceId: invoice.Id,
    docNumber: invoice.DocNumber,
    total: invoice.TotalAmt,
  });
  return invoice;
}

export async function getInvoice(invoiceId) {
  const res = await retailQbo.get(`/invoice/${invoiceId}`);
  return res?.Invoice || null;
}

// ── Payments (mark an invoice Paid) ──────────────────────────────────

// Create a QBO Payment that fully applies to one invoice, so QBO shows the
// invoice Paid (Balance → 0). Idempotent at the QBO layer via `requestid`.
// `amount` should equal the invoice's current Balance. `paymentRefNum` carries
// the Shopify payment reference (QBO caps it at 21 chars). Returns the Payment.
export async function createPaymentForInvoice({
  customerId,
  invoiceId,
  amount,
  txnDate,
  paymentRefNum,
  currency,
  privateNote,
  requestId,
}) {
  if (!customerId) throw new Error("createPaymentForInvoice: customerId is required");
  if (!invoiceId) throw new Error("createPaymentForInvoice: invoiceId is required");
  const total = round2(amount);
  if (!(total > 0)) {
    throw new Error(`createPaymentForInvoice: amount must be > 0 (got ${amount})`);
  }

  const payload = {
    CustomerRef: { value: String(customerId) },
    TotalAmt: total,
    ...(txnDate ? { TxnDate: toQboDate(txnDate) } : {}),
    ...(paymentRefNum ? { PaymentRefNum: String(paymentRefNum).slice(0, 21) } : {}),
    ...(currency ? { CurrencyRef: { value: currency } } : {}),
    ...(retailQboConfig.depositAccountId
      ? { DepositToAccountRef: { value: String(retailQboConfig.depositAccountId) } }
      : {}),
    ...(privateNote ? { PrivateNote: String(privateNote).slice(0, 4000) } : {}),
    Line: [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: String(invoiceId), TxnType: "Invoice" }],
      },
    ],
  };

  const res = await retailQbo.post("/payment", payload, undefined, {
    requestId: (requestId || `retail-pay-${invoiceId}`).slice(0, 50),
  });
  const payment = res?.Payment;
  if (!payment?.Id) {
    throw new Error("createPaymentForInvoice: QBO did not return a Payment id");
  }
  log.info("payment.created", {
    invoiceId,
    paymentId: payment.Id,
    total: payment.TotalAmt,
    paymentRefNum: payment.PaymentRefNum,
  });
  return payment;
}

// Deep link for the admin UI so operators can open the payment in QBO.
export function paymentWebUrl(paymentId) {
  return `${retailQboConfig.appBaseUrl}/app/recvpayment?txnId=${paymentId}`;
}

// Mirror shipment carrier + tracking + ship date onto the QBO invoice via a
// sparse update. Re-fetches the invoice first for a fresh SyncToken so we
// never collide on a stale token. Returns the updated Invoice (carries the
// new SyncToken).
export async function syncInvoiceShipping({ invoiceId, shipDate, trackingNum, memo }) {
  const current = await getInvoice(invoiceId);
  if (!current?.Id) throw new Error(`syncInvoiceShipping: invoice ${invoiceId} not found`);

  const payload = {
    Id: String(current.Id),
    SyncToken: current.SyncToken,
    sparse: true,
    ...(shipDate ? { ShipDate: toQboDate(shipDate) } : {}),
    ...(trackingNum ? { TrackingNum: String(trackingNum).slice(0, 31) } : {}),
    ...(memo ? { CustomerMemo: { value: String(memo).slice(0, 1000) } } : {}),
  };

  const res = await retailQbo.update("/invoice", payload);
  const updated = res?.Invoice;
  if (!updated?.Id) throw new Error("syncInvoiceShipping: QBO did not return the updated Invoice");
  log.info("invoice.shipping_synced", { invoiceId, trackingNum, shipDate });
  return updated;
}

// Email the invoice to the customer via QBO's send endpoint. `email` (when
// provided) overrides the invoice's BillEmail as the recipient. QBO flips the
// invoice's EmailStatus to "EmailSent". Used both right after creation (invoice
// delivery) and after a shipping update (shipment notification — the memo by
// then carries the carrier + tracking + URL + status). Returns the Invoice.
export async function sendInvoice({ invoiceId, email }) {
  if (!invoiceId) throw new Error("sendInvoice: invoiceId is required");
  const res = await qboRetailRequest({
    method: "POST",
    path: `/invoice/${invoiceId}/send`,
    query: email ? { sendTo: email } : undefined,
    // QBO's /send endpoint takes no JSON body; octet-stream is the documented
    // content type for the empty-body send.
    contentType: "application/octet-stream",
  });
  const invoice = res?.Invoice || null;
  log.info("invoice.sent", { invoiceId, email, emailStatus: invoice?.EmailStatus });
  return invoice;
}

// Fetch the rendered invoice PDF straight from QBO. Used by the admin
// "Preview invoice" action — we hold the OAuth token, the admin doesn't.
// Returns { buffer, contentType }.
export async function getInvoicePdf(invoiceId) {
  if (!invoiceId) throw new Error("getInvoicePdf: invoiceId is required");
  return qboRetailGetBinary(`/invoice/${encodeURIComponent(invoiceId)}/pdf`, {
    accept: "application/pdf",
  });
}

// Deep link for the admin UI so operators can open the invoice in QBO.
export function invoiceWebUrl(invoiceId) {
  return `${retailQboConfig.appBaseUrl}/app/invoice?txnId=${invoiceId}`;
}
