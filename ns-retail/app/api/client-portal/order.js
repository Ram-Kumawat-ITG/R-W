// GET /api/client-portal/order?id=<mongoId> — single order detail. The id
// is unauthenticated client input; ownership is verified server-side in
// getOrderDetail (mismatch/missing → null → generic "not found", never a
// 403 that would confirm the id exists but belongs to someone else).
import { portalLoader, portalAction } from "./_guard";
import { ok, badRequest } from "../../services/APIService/api.service";
import { getOrderDetail } from "../../services/cdo/cdo.clientPortal.service";

export const loader = portalLoader(async ({ ctx, url }) => {
  const id = url.searchParams.get("id");
  if (!id) return badRequest("Missing order id");
  const order = await getOrderDetail(ctx.customerId, id);
  return ok(order ? "OK" : "Order not found", order);
});

export const action = portalAction;
