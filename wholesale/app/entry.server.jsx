import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import connectDB from "./services/APIService/mongo.service";
import { getAgenda } from "./services/scheduler/scheduler.service";
import { assertSafeBootConfig } from "./configs";
import { qboConfig } from "./services/qbo/qbo.config";
import { nmiConfig } from "./services/nmi/nmi.config";
import { paymentConfig } from "./services/payment/payment.config";
import { schedulerConfig } from "./services/scheduler/scheduler.config";
import { shopifyConfig } from "./services/shopify/shopify.config";
import { createLogger } from "./utils/logger.utils";

// Scrub NMI_TEST_* if accidentally set in a non-sandbox environment.
// Runs at module load — before anything reads nmi.testCard.
assertSafeBootConfig();

export const streamTimeout = 5000;

// Boot banner — prints once per process. Shows public URL, payment
// config, and which credentials are present (without exposing values)
// so dev console makes it obvious how the app is configured.
function printBootBanner() {
  const mask = (v) => (v ? `set (${String(v).length} chars)` : "MISSING");
  console.log("\n=========================================================");
  console.log("  Natural Solutions wholesale app — boot");
  console.log("=========================================================");
  console.log(`  SHOPIFY_APP_URL           : ${shopifyConfig.appUrl || "(not set — webhooks will use shopify.app.toml's application_url)"}`);
  console.log(`  Webhook endpoint          : ${(shopifyConfig.appUrl || "(app-url)").replace(/\/$/, "")}/webhooks/orders/create`);
  console.log(`  MONGODB_URI               : ${mask(process.env.MONGODB_URI)}`);
  console.log("  --- QBO ---");
  console.log(`  QBO_ENVIRONMENT           : ${qboConfig.environment}`);
  console.log(`  QBO_API_BASE_URL          : ${qboConfig.apiBaseUrl}`);
  console.log(`  QBO_CLIENT_ID             : ${mask(qboConfig.clientId)}`);
  console.log(`  QBO_CLIENT_SECRET         : ${mask(qboConfig.clientSecret)}`);
  console.log(`  QBO_REALM_ID              : ${qboConfig.realmId || "MISSING"}`);
  console.log(`  QBO_REFRESH_TOKEN (seed)  : ${mask(qboConfig.bootstrapRefreshToken)}`);
  console.log(`  QBO_DEFAULT_ITEM_ID       : ${qboConfig.defaultItemId}`);
  console.log("  --- NMI ---");
  console.log(`  NMI_ENVIRONMENT           : ${nmiConfig.environment}`);
  console.log(`  NMI_API_URL               : ${nmiConfig.apiUrl}`);
  console.log(`  NMI_QUERY_URL             : ${nmiConfig.queryUrl}`);
  console.log(`  NMI_SECURITY_KEY          : ${mask(nmiConfig.securityKey)}`);
  const tc = nmiConfig.testCard;
  const tcStatus = tc.ccnumber && tc.ccexp
    ? `ACTIVE — last4 ${String(tc.ccnumber).slice(-4)} exp ${tc.ccexp}`
    : "(not set)";
  console.log(`  NMI test card (dev only)  : ${tcStatus}`);
  console.log("  --- Payments ---");
  console.log(`  PAYMENT_CHARGE_IMMEDIATELY: ${paymentConfig.chargeImmediately}`);
  console.log(`  PAYMENT_MAX_RETRY_ATTEMPTS: ${paymentConfig.maxRetryAttempts}`);
  console.log(`  PAYMENT_RETRY_INTERVAL    : ${schedulerConfig.retryIntervalOverride || "(unset — using cron)"}`);
  console.log(`  PAYMENT_RETRY_CRON_PRIMARY: ${schedulerConfig.retryCronPrimary}`);
  console.log(`  PAYMENT_RETRY_CRON_SECONDARY: ${schedulerConfig.retryCronSecondary}`);
  console.log(`  PAYMENT_SCHEDULE_TZ       : ${schedulerConfig.scheduleTimezone}`);
  console.log("  --- Logging ---");
  console.log(`  LOG_PRETTY                : ${process.env.LOG_PRETTY === "true"}`);
  console.log(`  LOG_LEVEL                 : ${process.env.LOG_LEVEL || "info"}`);
  console.log("=========================================================\n");
}

// Boot the background scheduler exactly once per process. Fire-and-forget
// so a slow Mongo connection doesn't delay HTTP serving; failures are
// logged but do not crash the server (webhooks still queue locally).
const bootLog = createLogger("boot");
printBootBanner();
(async () => {
  try {
    await connectDB();
    console.log("[boot] MongoDB connected");
    await verifyCriticalIndexes();
    await getAgenda();
    console.log("[boot] Agenda scheduler started");
    bootLog.info("scheduler.ready");
  } catch (err) {
    console.error("[boot] FAILED:", err.stack || err);
    bootLog.error("scheduler.boot_failed", { err });
  }
})();

// Confirm the duplicate-prevention indexes built. If a unique index is
// missing because old duplicate rows are blocking it, log a loud warning
// so the operator knows to dedupe before relying on the safety net.
async function verifyCriticalIndexes() {
  try {
    const { default: mongoose } = await import("mongoose");
    const db = mongoose.connection.db;
    const checks = [
      { coll: "invoices", expected: { shop: 1, shopifyOrderId: 1 }, label: "Invoice unique (shop, shopifyOrderId)" },
      { coll: "shopify_orders", expected: { shop: 1, shopifyOrderId: 1 }, label: "ShopifyOrder unique (shop, shopifyOrderId)" },
    ];
    for (const { coll, expected, label } of checks) {
      const idx = await db.collection(coll).indexes().catch(() => []);
      const found = idx.find(
        (i) => i.unique && JSON.stringify(i.key) === JSON.stringify(expected),
      );
      if (found) {
        console.log(`[boot] index OK     — ${label} (name=${found.name})`);
      } else {
        console.warn(
          `[boot] index MISSING — ${label}. ` +
            "Duplicate-prevention safety net is NOT active. " +
            "Most likely cause: existing duplicate rows are blocking the index build. " +
            "Dedupe the collection then restart.",
        );
      }
    }
  } catch (err) {
    console.warn("[boot] index verify failed:", err.message);
  }
}

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
