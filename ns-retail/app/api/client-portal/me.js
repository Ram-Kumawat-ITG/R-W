// GET /api/client-portal/me — bootstrap endpoint. The Client Portal calls
// this first (via the ns-retail storefront's App Proxy) to confirm the
// visitor is a logged-in retail customer before rendering the dashboard.
import { portalLoader, portalAction } from "./_guard";
import { ok } from "../../services/APIService/api.service";

export const loader = portalLoader(async ({ ctx }) => {
  return ok("Authenticated", { customerId: ctx.customerId });
});

export const action = portalAction;
