// Admin endpoint: proxies the vendor bill PDF from ns-retail's /api/cdo/bill-pdf.
// The wholesale app can't fetch the bill directly (it lives in ns-retail's QBO realm).
// Auth: Shopify admin session via authenticate.admin.
import { authenticate } from "../../shopify.server";
import ShopifyOrder from "../../models/order.server";
import DropshipMapping from "../../models/dropshipMapping.server";
import { syncConfig } from "../../services/sync/sync.config";
import connectDB from "../../services/APIService/mongo.service";

export async function action({ request, params }) {
  await authenticate.admin(request);
  const { id } = params;

  const { nsRetailApiBase, syncSecret } = syncConfig;
  if (!nsRetailApiBase || !syncSecret) {
    return Response.json(
      { status: "error", message: "Retail sync not configured (NS_RETAIL_API_BASE / RETAIL_SYNC_SECRET missing)" },
      { status: 503 },
    );
  }

  await connectDB();
  const order = await ShopifyOrder.findById(id).select("shopifyOrderId").lean();
  if (!order) {
    return Response.json({ status: "error", message: "Order not found" }, { status: 404 });
  }

  const mapping = await DropshipMapping.findOne({ wholesaleOrderId: order.shopifyOrderId })
    .select("retailShop retailOrderGid")
    .lean();
  if (!mapping?.retailOrderGid) {
    return Response.json(
      { status: "error", message: "No retail order linked to this drop-ship order" },
      { status: 404 },
    );
  }

  const url = `${nsRetailApiBase}/api/cdo/bill-pdf`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sync-secret": syncSecret },
      body: JSON.stringify({ shop: mapping.retailShop, shopifyOrderId: mapping.retailOrderGid }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return Response.json(
      { status: "error", message: `Network error reaching ns-retail: ${err?.message}` },
      { status: 502 },
    );
  }

  const data = await resp.json().catch(() => ({ status: "error", message: "Invalid JSON from ns-retail" }));
  return Response.json(data, { status: resp.ok ? 200 : resp.status });
}
