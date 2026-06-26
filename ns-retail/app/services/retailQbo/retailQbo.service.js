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
  const invoiceDocNumber = order.orderName || String(order.shopifyOrderId || "").split("/").pop() || "";
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
    ...(invoiceDocNumber ? { DocNumber: String(invoiceDocNumber).slice(0, 21) } : {}),
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

export async function getBillPdf(billId) {
  if (!billId) throw new Error("getBillPdf: billId is required");
  return qboRetailGetBinary(`/bill/${encodeURIComponent(billId)}/pdf`, {
    accept: "application/pdf",
  });
}

// Deep link for the admin UI so operators can open the invoice in QBO.
export function invoiceWebUrl(invoiceId) {
  return `${retailQboConfig.appBaseUrl}/app/invoice?txnId=${invoiceId}`;
}

// ── Vendor Bills (A/P "money out" — dropship cost) ───────────────────
//
// The accounts-PAYABLE counterpart to the customer Invoice above, posted to
// the SAME retail company. Each dropship order records what the retail store
// owes the wholesale supplier ("Natural Solution Wholesale") as an UNPAID QBO
// Bill, mirroring the wholesale invoice for the same order. Orchestrated by
// retailVendorBill.service.js. The customer-invoice (A/R) path is untouched.

// Vendor lookup helpers (mirror the CDO payout client's, but on the retail
// realm). QBO returns ACTIVE entities by default; a deactivated vendor is
// found via a second `Active = false` query. The GET /vendor/{id} read 610s on
// an inactive vendor, so we always look up via query.
async function queryOneVendor(whereClause) {
  let res = await retailQbo.query(`SELECT * FROM Vendor WHERE ${whereClause}`);
  let v = res?.QueryResponse?.Vendor?.[0];
  if (v) return v;
  res = await retailQbo.query(`SELECT * FROM Vendor WHERE ${whereClause} AND Active = false`);
  return res?.QueryResponse?.Vendor?.[0] || null;
}

async function queryVendorByDisplayName(displayName) {
  if (!displayName) return null;
  return queryOneVendor(`DisplayName = '${escapeQuery(displayName)}'`);
}

// QBO QL can't filter Vendor by the complex PrimaryEmailAddr field, so fetch
// and match client-side (active then inactive).
async function queryVendorByEmail(email) {
  if (!email) return null;
  const target = String(email).toLowerCase();
  const match = (list) =>
    list.find((v) => (v.PrimaryEmailAddr?.Address || "").toLowerCase() === target);
  let res = await retailQbo.query("SELECT * FROM Vendor MAXRESULTS 1000");
  let v = match(res?.QueryResponse?.Vendor || []);
  if (v) return v;
  res = await retailQbo.query("SELECT * FROM Vendor WHERE Active = false MAXRESULTS 1000");
  return match(res?.QueryResponse?.Vendor || []) || null;
}

// A Bill can't post to an inactive vendor — flip it back to Active via a sparse
// update. Idempotent on an already-active vendor.
async function reactivateVendor(vendor) {
  const res = await retailQbo.update("/vendor", {
    Id: String(vendor.Id),
    SyncToken: vendor.SyncToken,
    Active: true,
    sparse: true,
  });
  return res?.Vendor || vendor;
}

// Module-memoized so we resolve the wholesale-supplier vendor once per process.
let _dropshipVendorId = null;

// Resolve the QBO Vendor id the dropship bills post to:
//   1. configured id (QBO_RETAIL_DROPSHIP_VENDOR_ID / QBO_RETAIL_ADMIN_VENDOR) — verbatim
//   2. adopt an existing vendor by email / DisplayName (incl. inactive)
//   3. create it under the configured name + email
// Returns the vendor id as a string.
export async function resolveDropshipVendorId() {
  if (_dropshipVendorId) return _dropshipVendorId;

  if (retailQboConfig.dropshipVendorId) {
    _dropshipVendorId = String(retailQboConfig.dropshipVendorId);
    return _dropshipVendorId;
  }

  const name = retailQboConfig.dropshipVendorName;
  const email = retailQboConfig.dropshipVendorEmail;

  let vendor =
    (await queryVendorByEmail(email)) || (await queryVendorByDisplayName(name));

  if (!vendor) {
    const payload = {
      DisplayName: String(name).slice(0, 100),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    };
    try {
      const created = await retailQbo.post("/vendor", payload);
      vendor = created?.Vendor || null;
    } catch (err) {
      const code = err?.body?.Fault?.Error?.[0]?.code;
      if (code === "6240" || /duplicate/i.test(err?.message || "")) {
        vendor = await queryVendorByDisplayName(name);
      }
      if (!vendor) throw err;
    }
  }

  if (!vendor?.Id) {
    throw new Error(`Retail QBO: failed to resolve the dropship vendor "${name}"`);
  }
  if (vendor.Active === false) vendor = await reactivateVendor(vendor);

  _dropshipVendorId = String(vendor.Id);
  log.info("dropship_vendor.resolved", { qboVendorId: _dropshipVendorId, name });
  return _dropshipVendorId;
}

// Module-memoized expense account for the bill lines.
let _dropshipExpenseAccountId = null;

// Resolve the expense/COGS account each bill line posts to:
//   1. QBO_RETAIL_DROPSHIP_EXPENSE_ACCOUNT_ID override (verbatim)
//   2. first "Cost of Goods Sold" account in the chart of accounts
//   3. first "Expense" account
export async function resolveDropshipExpenseAccountId() {
  if (_dropshipExpenseAccountId) return _dropshipExpenseAccountId;
  if (retailQboConfig.dropshipExpenseAccountId) {
    _dropshipExpenseAccountId = String(retailQboConfig.dropshipExpenseAccountId);
    return _dropshipExpenseAccountId;
  }

  const cogs = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Cost of Goods Sold' MAXRESULTS 1",
  );
  const cogsAcct = cogs?.QueryResponse?.Account?.[0];
  if (cogsAcct?.Id) {
    _dropshipExpenseAccountId = String(cogsAcct.Id);
    return _dropshipExpenseAccountId;
  }

  const exp = await retailQbo.query(
    "SELECT Id, Name FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1",
  );
  const expAcct = exp?.QueryResponse?.Account?.[0];
  if (expAcct?.Id) {
    _dropshipExpenseAccountId = String(expAcct.Id);
    return _dropshipExpenseAccountId;
  }

  throw new Error(
    "Retail QBO: no Cost of Goods Sold / Expense account found for the dropship bill. " +
      "Set QBO_RETAIL_DROPSHIP_EXPENSE_ACCOUNT_ID.",
  );
}

// The retail order's shipping cost mirrored onto the bill (the wholesale draft
// order copies retail's FIRST shipping line at full cost — match that).
function firstShippingPrice(order) {
  const lines = Array.isArray(order?.shippingLines) ? order.shippingLines : [];
  if (lines.length) return round2(lines[0]?.price);
  return round2(order?.pricing?.totalShipping);
}

// Build the QBO Bill payload from a cdo_orders snapshot, mirroring the wholesale
// dropship invoice: one AccountBasedExpenseLine per product at the actual
// WHOLESALE product price + an optional Shipping line at full retail cost.
// Idempotent at the QBO layer via `requestid`. Returns the created Bill.
//
// Per-line unit pricing precedence (keeps the bill in sync with the wholesale
// invoice, which prices from the same source):
//   1. wholesalePriceByVariantId — the actual wholesale Shopify variant price
//      (sync_id_maps.wholesalePrice), keyed by the line's retail variant id.
//   2. retail BASE unit price × priceFactor — graceful fallback when a
//      variant's wholesale price snapshot isn't populated (legacy ½ behavior).
// Discounts are ignored in both cases (matching the wholesale base formula).
export async function createBillForOrder({
  order,
  vendorId,
  expenseAccountId,
  apAccountId,
  priceFactor = 0.5,
  wholesalePriceByVariantId,
  includeShipping = true,
  requestId,
}) {
  if (!vendorId) throw new Error("createBillForOrder: vendorId is required");
  if (!expenseAccountId) throw new Error("createBillForOrder: expenseAccountId is required");

  const factor = Number.isFinite(Number(priceFactor)) ? Number(priceFactor) : 0.5;
  const wsPrices =
    wholesalePriceByVariantId instanceof Map ? wholesalePriceByVariantId : new Map();
  const expenseRef = { value: String(expenseAccountId) };
  const lines = [];

  for (const li of order.lineItems || []) {
    const qty = Number(li.quantity) || 0;
    // Prefer the actual wholesale product price; fall back to retail × factor.
    const mapped = li.variantId != null ? wsPrices.get(String(li.variantId)) : undefined;
    const unit =
      Number.isFinite(mapped) && mapped > 0
        ? round2(mapped)
        : round2((Number(li.price) || 0) * factor);
    const amount = round2(unit * qty);
    if (!(amount > 0)) continue;
    const titleParts = [li.title, li.variantTitle].filter(Boolean).join(" · ");
    const desc = [
      titleParts,
      li.sku ? `SKU: ${li.sku}` : null,
      `${qty} × ${unit.toFixed(2)} (wholesale)`,
    ]
      .filter(Boolean)
      .join(" — ");
    lines.push({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: amount,
      ...(desc ? { Description: desc.slice(0, 4000) } : {}),
      AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
    });
  }

  if (includeShipping) {
    const shipping = firstShippingPrice(order);
    if (shipping > 0) {
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: shipping,
        Description: "Shipping",
        AccountBasedExpenseLineDetail: { AccountRef: expenseRef },
      });
    }
  }

  if (lines.length === 0) {
    throw new Error("createBillForOrder: order has no billable lines");
  }

  const orderRef = order.orderName || order.shopifyOrderId || "";
  const payload = {
    VendorRef: { value: String(vendorId) },
    Line: lines,
    ...(apAccountId ? { APAccountRef: { value: String(apAccountId) } } : {}),
    ...(order.placedAt ? { TxnDate: toQboDate(order.placedAt) } : {}),
    // Vendor's reference for the bill — RS-<retail order number> for traceability
    // and to match the corresponding wholesale Admin Order Invoice (RS-#1234).
    ...(orderRef ? { DocNumber: `RS-${orderRef}`.slice(0, 21) } : {}),
    PrivateNote: `Dropship cost — retail order ${orderRef} → ${retailQboConfig.dropshipVendorName}`
      .trim()
      .slice(0, 4000),
    ...(order.currency ? { CurrencyRef: { value: order.currency } } : {}),
  };

  const shortOrderId = String(order.shopifyOrderId || "").split("/").pop() || "x";
  const res = await retailQbo.post("/bill", payload, undefined, {
    requestId: (requestId || `retail-bill-${shortOrderId}`).slice(0, 50),
  });
  const bill = res?.Bill;
  if (!bill?.Id) throw new Error("createBillForOrder: QBO did not return a Bill id");
  log.info("bill.created", {
    shopifyOrderId: order.shopifyOrderId,
    billId: bill.Id,
    docNumber: bill.DocNumber,
    total: bill.TotalAmt,
  });
  return bill;
}

export async function getBill(billId) {
  const res = await retailQbo.get(`/bill/${billId}`);
  return res?.Bill || null;
}

// Record a BillPayment that fully applies to one vendor Bill, so QBO shows the
// bill Paid (Balance → 0) — the A/P counterpart to createPaymentForInvoice.
// Drawn from the configured bank/clearing account (PayType "Check" is QBO's
// representation of a bank-account disbursement; this RECORDS the payment in
// the ledger — it does not itself move money). `amount` should equal the bill's
// current Balance. Idempotent at the QBO layer via `requestid`. Returns the
// created BillPayment.
export async function createBillPaymentForBill({
  vendorId,
  billId,
  amount,
  txnDate,
  currency,
  privateNote,
  requestId,
}) {
  if (!vendorId) throw new Error("createBillPaymentForBill: vendorId is required");
  if (!billId) throw new Error("createBillPaymentForBill: billId is required");
  if (!retailQboConfig.paymentAccountId) {
    throw new Error(
      "createBillPaymentForBill: QBO_RETAIL_PAYMENT_ACCOUNT_ID is not set — " +
        "cannot record the bill payment without a bank/clearing account.",
    );
  }
  const total = round2(amount);
  if (!(total > 0)) {
    throw new Error(`createBillPaymentForBill: amount must be > 0 (got ${amount})`);
  }

  const payload = {
    VendorRef: { value: String(vendorId) },
    TotalAmt: total,
    PayType: "Check",
    CheckPayment: { BankAccountRef: { value: String(retailQboConfig.paymentAccountId) } },
    ...(txnDate ? { TxnDate: toQboDate(txnDate) } : {}),
    ...(currency ? { CurrencyRef: { value: currency } } : {}),
    ...(privateNote ? { PrivateNote: String(privateNote).slice(0, 4000) } : {}),
    Line: [
      {
        Amount: total,
        LinkedTxn: [{ TxnId: String(billId), TxnType: "Bill" }],
      },
    ],
  };

  const res = await retailQbo.post("/billpayment", payload, undefined, {
    requestId: (requestId || `retail-billpay-${billId}`).slice(0, 50),
  });
  const payment = res?.BillPayment;
  if (!payment?.Id) {
    throw new Error("createBillPaymentForBill: QBO did not return a BillPayment id");
  }
  log.info("billpayment.created", { vendorId, billId, billPaymentId: payment.Id, total });
  return payment;
}

// Deep link for the admin UI so operators can open the bill in QBO.
export function billWebUrl(billId) {
  return `${retailQboConfig.appBaseUrl}/app/bill?txnId=${billId}`;
}

// Deep link to a bill payment in QBO.
export function billPaymentWebUrl(billPaymentId) {
  return `${retailQboConfig.appBaseUrl}/app/billpayment?txnId=${billPaymentId}`;
}
