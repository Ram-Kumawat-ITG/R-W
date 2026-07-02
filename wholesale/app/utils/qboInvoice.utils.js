// Pure projection of a raw QBO Invoice entity into the shape the admin UI
// renders. No I/O, no env — safe to import from any loader. Shared by the
// wholesale Order Details page (app.orders.$id.jsx) and the Admin Order
// Details page (app.admin-orders.$id.jsx) so the live-QBO-invoice panel reads
// identically on both.
//
// Pull only the fields we render. QBO invoices include a lot of extra payload
// (custom fields, sales terms, classification refs, etc.) that the admin UI
// doesn't surface today.
export function projectQboInvoice(inv) {
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

  // Classify the QBO SalesItemLineDetail rows so the panel can show a full,
  // always-on itemized breakdown (Subtotal of products → Discount → Shipping
  // → Tax → Processing Fee → Grand total). The descriptions are the ones we
  // author at creation: "Shipping" (exact) and "<Method> Processing Fee – X%
  // of $Y". Anything else is a product line.
  const FEE_RE = /processing fee/i;
  const SHIP_RE = /^\s*shipping\s*$/i;
  const productLines = [];
  let shipping = 0;
  let processingFee = 0;
  let processingFeeLabel = null;
  for (const l of itemLines) {
    const desc = l.description || "";
    if (FEE_RE.test(desc)) {
      processingFee += l.amount || 0;
      processingFeeLabel = desc; // self-documenting: "… – 3% of $596.58"
    } else if (SHIP_RE.test(desc)) {
      shipping += l.amount || 0;
    } else {
      productLines.push(l);
    }
  }
  const productSubtotal = Number(
    productLines.reduce((s, l) => s + (l.amount || 0), 0).toFixed(2),
  );
  shipping = Number(shipping.toFixed(2));
  processingFee = Number(processingFee.toFixed(2));
  const discount = Number(
    lines
      .filter((l) => l.DetailType === "DiscountLineDetail")
      .reduce((s, l) => s + (l.Amount != null ? Number(l.Amount) : 0), 0)
      .toFixed(2),
  );
  const totalTax = inv.TxnTaxDetail?.TotalTax != null ? Number(inv.TxnTaxDetail.TotalTax) : 0;
  const totalAmt = inv.TotalAmt != null ? Number(inv.TotalAmt) : null;
  // Reconciling catch-all: any portion of the QBO total not explained by the
  // classified rows surfaces as "Other charges" so the breakdown always sums
  // to TotalAmt (and we never silently hide a charge).
  const otherCharges =
    totalAmt != null
      ? Number(
          (
            totalAmt -
            (productSubtotal - discount + shipping + totalTax + processingFee)
          ).toFixed(2),
        )
      : 0;

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
    totalAmt,
    balance: inv.Balance != null ? Number(inv.Balance) : null,
    totalTax,
    createTime: inv.MetaData?.CreateTime || null,
    lastUpdatedTime: inv.MetaData?.LastUpdatedTime || null,
    lines: itemLines,
    // Full itemized breakdown (always-on rows): products subtotal → discount
    // → shipping → tax → processing fee → other → grand total.
    productLines,
    productSubtotal,
    discount,
    shipping,
    processingFee,
    processingFeeLabel,
    otherCharges,
    linkedPayments,
  };
}
