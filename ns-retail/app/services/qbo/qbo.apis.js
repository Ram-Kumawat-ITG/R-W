/* eslint-env node */
// CDO QBO HTTP client — OAuth2 token rotation, refresh coalescing,
// 401-retry-once, `requestid` idempotency, and Fault-structured error
// classification. Pure transport; domain methods live in qbo.service.js.
//
// Independent from the wholesale QBO client: reads the CDO realm's config
// (qbo.config) and persists tokens in the cdo_qbo_tokens collection
// (CdoQboToken). The two QBO accounts never share state.

import { randomUUID } from "node:crypto";
import { qboConfig, assertQboConfigured } from "./qbo.config";
import { ACCESS_TOKEN_SAFETY_MS } from "./qbo.constants";
import { readInt } from "../../utils/env.utils";
import { createLogger } from "../../utils/logger.utils";
import { retry, PermanentError, TransientError } from "../../utils/retry.utils";
import CdoQboToken from "../../models/cdoQboToken.server";

const log = createLogger("cdo.qbo.apis");

const RETRY = {
  attempts: readInt("CDO_QBO_HTTP_RETRY_ATTEMPTS", 4),
  baseMs: readInt("CDO_QBO_HTTP_RETRY_BASE_MS", 500),
  maxMs: readInt("CDO_QBO_HTTP_RETRY_MAX_MS", 4000),
};

function truncate(str, max = 1000) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// Access tokens last 60 min; refresh tokens last ~100 days and ROTATE on
// every refresh. We persist the rotated refresh token immediately so a
// crash-after-refresh doesn't strand us with an expired access token and
// a stale refresh token.

let inFlightRefresh = null;

async function readTokenDoc() {
  return CdoQboToken.findOne({ realmId: qboConfig.realmId }).lean();
}

async function bootstrapTokenDocFromEnv() {
  // First run: no token doc exists yet. Seed from the env-provided refresh
  // token, then immediately refresh to populate access token + new refresh.
  if (!qboConfig.bootstrapRefreshToken) {
    throw new PermanentError(
      "CDO QBO has no stored token and CDO_QBO_REFRESH_TOKEN is empty. " +
        "Seed an initial refresh token via the Intuit OAuth Playground.",
    );
  }
  const seedDoc = await CdoQboToken.findOneAndUpdate(
    { realmId: qboConfig.realmId },
    {
      $setOnInsert: {
        realmId: qboConfig.realmId,
        refreshToken: qboConfig.bootstrapRefreshToken,
        accessToken: "pending",
        accessTokenExpiresAt: new Date(0),
      },
    },
    { upsert: true, new: true },
  ).lean();
  return seedDoc;
}

async function refreshAccessToken(currentRefreshToken) {
  // Coalesce concurrent refreshes so we don't burn Intuit's refresh-rate
  // limit when many jobs trigger at once (e.g. a payout-batch tick).
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const basic = Buffer.from(
      `${qboConfig.clientId}:${qboConfig.clientSecret}`,
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    });

    const res = await fetch(qboConfig.oauthTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TransientError(`CDO QBO token refresh non-JSON response (${res.status})`, {
        status: res.status,
        body: text,
      });
    }

    if (!res.ok) {
      // 400 invalid_grant → refresh token expired/revoked. Permanent.
      if (res.status === 400 || res.status === 401) {
        throw new PermanentError(`CDO QBO token refresh failed: ${json.error || res.status}`, {
          status: res.status,
          body: json,
        });
      }
      throw new TransientError(`CDO QBO token refresh failed: ${json.error || res.status}`, {
        status: res.status,
        body: json,
      });
    }

    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + (json.expires_in ?? 3600) * 1000);
    const refreshTokenExpiresAt = new Date(now + (json.x_refresh_token_expires_in ?? 8726400) * 1000);

    const updated = await CdoQboToken.findOneAndUpdate(
      { realmId: qboConfig.realmId },
      {
        $set: {
          accessToken: json.access_token,
          accessTokenExpiresAt,
          refreshToken: json.refresh_token,
          refreshTokenExpiresAt,
          tokenType: json.token_type || "bearer",
        },
      },
      { upsert: true, new: true },
    ).lean();

    log.info("token.refreshed", { expiresAt: accessTokenExpiresAt });
    return updated;
  })();
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

async function getAccessToken() {
  assertQboConfigured();

  let doc = await readTokenDoc();
  if (!doc) doc = await bootstrapTokenDocFromEnv();

  const nowMs = Date.now();
  const expiresAt = doc.accessTokenExpiresAt?.getTime?.() ?? 0;
  if (doc.accessToken && doc.accessToken !== "pending" && expiresAt - ACCESS_TOKEN_SAFETY_MS > nowMs) {
    return doc.accessToken;
  }

  const refreshed = await refreshAccessToken(doc.refreshToken);
  return refreshed.accessToken;
}

function buildUrl(path, query, { requestId, method } = {}) {
  const base = `${qboConfig.apiBaseUrl}/v3/company/${qboConfig.realmId}`;
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("minorversion", qboConfig.minorVersion);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  // QBO's `requestid` idempotency token. If the same id is sent twice
  // (e.g. our retry layer re-firing after a transient response error even
  // though QBO already committed the create), QBO returns the original
  // response instead of creating a duplicate. Generated ONCE per logical
  // qboRequest() call and only applied to mutating verbs.
  if (requestId && method !== "GET") {
    url.searchParams.set("requestid", requestId);
  }
  return url.toString();
}

async function rawRequest({ method, path, query, body, contentType, requestId, retryOn401 = true }) {
  const accessToken = await getAccessToken();
  const url = buildUrl(path, query, { requestId, method });

  console.log(`\n[CDO-QBO →] ${method} ${path}${requestId ? ` (requestid=${requestId})` : ""}`);
  if (body) console.log(`            body: ${truncate(JSON.stringify(body), 1000)}`);

  const effectiveContentType = contentType || (body ? "application/json" : undefined);

  const startedAt = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(effectiveContentType ? { "Content-Type": effectiveContentType } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const elapsedMs = Date.now() - startedAt;

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) {
      throw new TransientError(`CDO QBO ${method} ${path} non-JSON (${res.status})`, {
        status: res.status,
        body: text,
      });
    }
    json = null;
  }

  console.log(`[CDO-QBO ←] ${method} ${path}  status=${res.status}  ${elapsedMs}ms`);
  if (!res.ok || process.env.LOG_PRETTY === "true") {
    console.log(`            response: ${truncate(text, 1500)}`);
  }

  if (res.status === 401 && retryOn401) {
    // Token might have been invalidated mid-flight. Force-refresh once and
    // retry, passing the SAME requestId so the retry stays idempotent.
    log.warn("token.invalid_retry", { path });
    const doc = await readTokenDoc();
    if (doc) await refreshAccessToken(doc.refreshToken);
    return rawRequest({ method, path, query, body, contentType, requestId, retryOn401: false });
  }

  if (!res.ok) {
    // QBO returns a structured `Fault` block for business errors.
    const fault = json?.Fault || json?.fault;
    const errorDetail = fault?.Error?.[0] || fault?.error?.[0];
    const msg =
      errorDetail?.Message || errorDetail?.message || `CDO QBO ${method} ${path} failed: ${res.status}`;
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError;
    throw new ErrorClass(msg, { status: res.status, body: json ?? text });
  }

  return json;
}

export async function qboRequest(opts) {
  // One idempotency token for the WHOLE logical operation, before the
  // retry loop. Every retry (including the 401-refresh recursion) reuses
  // it so QBO dedups retries that committed server-side but failed to
  // return a response. Callers can pin opts.requestId for cross-process
  // idempotency (e.g. resuming a crashed payout job).
  const requestId = opts.requestId || randomUUID();
  return retry(() => rawRequest({ ...opts, requestId }), {
    attempts: RETRY.attempts,
    baseMs: RETRY.baseMs,
    maxMs: RETRY.maxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn("request.retry", { attempt, nextDelayMs, err, requestId });
    },
  });
}

// Convenience helpers used by qbo.service.js.
export const qbo = {
  get: (path, query) => qboRequest({ method: "GET", path, query }),
  post: (path, body, query, opts = {}) =>
    qboRequest({ method: "POST", path, body, query, requestId: opts.requestId }),
  // QBO uses POST for updates with a sparse=true flag in the body.
  update: (path, body) => qboRequest({ method: "POST", path, body }),
  query: (statement) => qboRequest({ method: "GET", path: "/query", query: { query: statement } }),
};
