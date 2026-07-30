import connectDB from "../../services/APIService/mongo.service";
import { authenticate } from "../../shopify.server";
import WholesaleApplication from "../../models/wholesaleApplication.server";
import { hasOutstandingFailedInvoice } from "../../services/order/orderHold.service";
import {
  ok,
  methodNotAllowed,
  serverError,
} from "../../services/APIService/api.service";
import { createLogger } from "../../utils/logger.utils";

const log = createLogger("api.storefront.order_hold");

// The exact customer-facing message. Kept in sync with the checkout Function
// (extensions/cart-checkout-validation) — both surfaces show the same text.
const BLOCK_MESSAGE =
  "You have an outstanding invoice payment. Please pay your existing invoice before placing a new order. If you need assistance, please contact our support team.";

// GET /api/storefront/order-hold
//   (storefront, proxied via /apps/wholesale-application/api/storefront/order-hold)
//
// Reports whether the logged-in practitioner is on a PAYMENT order hold, so the
// storefront cart gate (theme app-embed block) can disable the checkout button
// and show the message BEFORE the buyer reaches checkout. The checkout-validation
// Function remains the un-bypassable server-side block on order completion; this
// endpoint is the UX layer that prevents reaching checkout in the first place.
//
// The hold is recomputed LIVE from invoice state (the source of truth), so it is
// always accurate even if the mirrored customer metafield is momentarily stale.
//
// Anonymous carts / non-practitioners simply get { held: false } (200) — no leak,
// the gate just doesn't act.
export async function loader({ request }) {
  let session;
  try {
    const auth = await authenticate.public.appProxy(request);
    session = auth.session;
  } catch (e) {
    log.info("auth.app_proxy_invalid", { err: e?.message || String(e) });
    // Fail open on auth: never block a legitimate buyer because of a proxy hiccup.
    return ok("ok", { held: false });
  }

  const shop = session?.shop;
  const rawCustomerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  if (!shop || !rawCustomerId) {
    // Not logged in (or no shop context) — nothing to hold.
    return ok("ok", { held: false });
  }

  const customerId = `gid://shopify/Customer/${rawCustomerId}`;

  try {
    await connectDB();

    const app = await WholesaleApplication.findOne({ shop, customerId }).select(
      "email orderHold",
    );
    if (!app?.email) {
      return ok("ok", { held: false });
    }

    const held = await hasOutstandingFailedInvoice({ shop, email: app.email });
    return ok("ok", { held, message: held ? BLOCK_MESSAGE : null });
  } catch (err) {
    log.error("lookup.failed", { shop, err: err?.message || String(err) });
    // Fail open — a lookup failure must never block a buyer who may not be held.
    return serverError("Lookup failed");
  }
}

export async function action() {
  return methodNotAllowed();
}
