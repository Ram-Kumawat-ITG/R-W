/* eslint-env node */
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import connectDB from "./db/mongo.server";
import { getAgenda } from "./services/scheduler/scheduler.service";
import { schedulerConfig } from "./services/scheduler/scheduler.config";
import { createLogger } from "./utils/logger.utils";

export const streamTimeout = 5000;

// Boot the CDO commission-payout scheduler exactly once per process.
// Fire-and-forget so a slow Mongo connection never delays HTTP serving;
// failures are logged but do not crash the server. Skipped under test and
// when CDO_SCHEDULER_DISABLED is set.
const bootLog = createLogger("boot");
if (process.env.NODE_ENV !== "test" && !schedulerConfig.disabled) {
  (async () => {
    try {
      await connectDB();
      console.log("[boot] MongoDB connected");
      await getAgenda();
      console.log(
        `[boot] CDO payout scheduler started (${
          schedulerConfig.payoutIntervalOverride
            ? `dev interval: ${schedulerConfig.payoutIntervalOverride}`
            : `cron: ${schedulerConfig.payoutCron} ${schedulerConfig.scheduleTimezone}`
        })`,
      );
      bootLog.info("scheduler.ready");
    } catch (err) {
      console.error("[boot] scheduler boot FAILED:", err.stack || err);
      bootLog.error("scheduler.boot_failed", { err });
    }
  })();
} else {
  console.log(
    `[boot] CDO payout scheduler NOT started (${
      schedulerConfig.disabled ? "CDO_SCHEDULER_DISABLED=true" : "test env"
    })`,
  );
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
