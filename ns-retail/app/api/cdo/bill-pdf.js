// Internal cross-repo endpoint: wholesale proxies vendor bill PDF requests here.
// Auth: x-sync-secret header matching RETAIL_SYNC_SECRET env var.
// Body: { shop, shopifyOrderId }
import { getRetailBillPdf } from "../../services/retailQbo/retailVendorBill.service";

export async function action({ request }) {
  const secret = process.env.RETAIL_SYNC_SECRET;
  if (!secret || request.headers.get("x-sync-secret") !== secret) {
    return Response.json({ status: "error", message: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ status: "error", message: "Invalid JSON body" }, { status: 400 });
  }
  const { shop, shopifyOrderId } = body || {};
  const r = await getRetailBillPdf({ shop, shopifyOrderId });
  if (r.ok) {
    return Response.json({
      status: "success",
      result: { base64: r.base64, contentType: r.contentType, filename: r.filename },
    });
  }
  if (r.reason === "no_bill") {
    return Response.json({ status: "error", message: "No vendor bill for this order" }, { status: 404 });
  }
  if (r.reason === "order_not_found") {
    return Response.json({ status: "error", message: "Order not found" }, { status: 404 });
  }
  return Response.json(
    { status: "error", message: r.error || "Failed to load vendor bill PDF" },
    { status: 502 },
  );
}
