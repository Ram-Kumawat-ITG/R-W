// GET /api/client-portal/invoice-pdf?id=<mongoId> — the order's real
// QBO-rendered invoice PDF, base64-encoded. The frontend turns this into
// a Blob + object URL and opens it directly in the browser — never a
// redirect to QBO's hosted invoice portal.
import { portalLoader, portalAction } from "./_guard";
import { ok, badRequest } from "../../services/APIService/api.service";
import { getOrderInvoicePdf } from "../../services/cdo/cdo.clientPortal.service";

const REASON_MESSAGE = {
  not_found: "Order not found.",
  no_invoice: "The invoice isn't ready yet for this order.",
  error: "Could not load the invoice right now. Please try again.",
};

export const loader = portalLoader(async ({ ctx, url }) => {
  const id = url.searchParams.get("id");
  if (!id) return badRequest("Missing order id");

  const r = await getOrderInvoicePdf(ctx.customerId, id);
  if (!r.ok) {
    // 200 with a null result (never a 403/404 status) — same
    // enumeration-safety principle as order.js: a missing invoice and a
    // missing/foreign order look identical to the caller.
    return ok(REASON_MESSAGE[r.reason] || REASON_MESSAGE.error, null);
  }

  return ok("OK", { base64: r.base64, contentType: r.contentType, filename: r.filename });
});

export const action = portalAction;
