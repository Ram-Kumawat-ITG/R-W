/* eslint-env node */
// Retail QBO HTTP client — OAuth2 token rotation, refresh coalescing,
// 401-retry-once, `requestid` idempotency, and Fault-structured error
// classification. Pure transport; domain methods live in retailQbo.service.js.
//
// This is a SECOND, independent QBO client (the retail A/R realm). It mirrors
// services/qbo/qbo.apis.js (the CDO payouts client) but is bound to
// retailQboConfig and stores its tokens under the retail realmId in the SAME
// cdo_qbo_tokens collection (that model is unique on realmId, so the two
// realms never collide). Kept separate from the CDO client so retail invoice
// work can never affect the payout pipeline.

import { randomUUID } from "node:crypto";
import { retailQboConfig, assertRetailQboConfigured } from "./retailQbo.config";
import { ACCESS_TOKEN_SAFETY_MS } from "../qbo/qbo.constants";
import { readInt } from "../../utils/env.utils";
import { createLogger } from "../../utils/logger.utils";
import { retry, PermanentError, TransientError } from "../../utils/retry.utils";
import CdoQboToken from "../../models/cdoQboToken.server";

const log = createLogger("retail.qbo.apis");

const RETRY = {
  attempts: readInt("CDO_QBO_HTTP_RETRY_ATTEMPTS", 4),
  baseMs: readInt("CDO_QBO_HTTP_RETRY_BASE_MS", 500),
  maxMs: readInt("CDO_QBO_HTTP_RETRY_MAX_MS", 4000),
};

function truncate(str, max = 1000) {
  if (typeof str !== "string") return str;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

let inFlightRefresh = null;

async function readTokenDoc() {
  return CdoQboToken.findOne({ realmId: retailQboConfig.realmId }).lean();
}

async function bootstrapTokenDocFromEnv() {
  if (!retailQboConfig.bootstrapRefreshToken) {
    throw new PermanentError(
      "Retail QBO has no stored token and CDO_QBO_Retail_REFRESH_TOKEN is empty. " +
        "Seed an initial refresh token via the Intuit OAuth Playground.",
    );
  }
  const seedDoc = await CdoQboToken.findOneAndUpdate(
    { realmId: retailQboConfig.realmId },
    {
      $setOnInsert: {
        realmId: retailQboConfig.realmId,
        refreshToken: retailQboConfig.bootstrapRefreshToken,
        accessToken: "pending",
        accessTokenExpiresAt: new Date(0),
      },
    },
    { upsert: true, new: true },
  ).lean();
  return seedDoc;
}

async function refreshAccessToken(currentRefreshToken) {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const basic = Buffer.from(
      `${retailQboConfig.clientId}:${retailQboConfig.clientSecret}`,
    ).toString("base64");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    });

    const res = await fetch(retailQboConfig.oauthTokenUrl, {
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
      throw new TransientError(`Retail QBO token refresh non-JSON response (${res.status})`, {
        status: res.status,
        body: text,
      });
    }

    if (!res.ok) {
      // 400 invalid_grant → refresh token expired/revoked. Permanent.
      if (res.status === 400 || res.status === 401) {
        throw new PermanentError(`Retail QBO token refresh failed: ${json.error || res.status}`, {
          status: res.status,
          body: json,
        });
      }
      throw new TransientError(`Retail QBO token refresh failed: ${json.error || res.status}`, {
        status: res.status,
        body: json,
      });
    }

    const now = Date.now();
    const accessTokenExpiresAt = new Date(now + (json.expires_in ?? 3600) * 1000);
    const refreshTokenExpiresAt = new Date(now + (json.x_refresh_token_expires_in ?? 8726400) * 1000);

    const updated = await CdoQboToken.findOneAndUpdate(
      { realmId: retailQboConfig.realmId },
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

    log.info("token.refreshed", { realmId: retailQboConfig.realmId, expiresAt: accessTokenExpiresAt });
    return updated;
  })();
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

async function getAccessToken() {
  assertRetailQboConfigured();

  let doc = await readTokenDoc();
  if (!doc) doc = await bootstrapTokenDocFromEnv();

  const nowMs = Date.now();
  const expiresAt = doc.accessTokenExpiresAt?.getTime?.() ?? 0;
  if (doc.accessToken && doc.accessToken !== "pending" && expiresAt - ACCESS_TOKEN_SAFETY_MS > nowMs) {
    return doc.accessToken;
  }

  // Refresh. If the STORED refresh token is rejected (invalid_grant — expired/
  // revoked, or a stale token seeded earlier) and the .env bootstrap token is
  // different (likely fresher — the operator just pasted a new one), retry once
  // with the env token before giving up. This self-heals the "Mongo is the
  // source of truth after first seed, so updating .env did nothing" trap.
  let refreshed;
  try {
    refreshed = await refreshAccessToken(doc.refreshToken);
  } catch (err) {
    const invalidGrant =
      err?.body?.error === "invalid_grant" || /invalid_grant/i.test(err?.message || "");
    const envToken = retailQboConfig.bootstrapRefreshToken;
    if (invalidGrant && envToken && envToken !== doc.refreshToken) {
      log.warn("token.stored_rejected_retry_env", { realmId: retailQboConfig.realmId });
      refreshed = await refreshAccessToken(envToken);
    } else {
      throw err;
    }
  }
  return refreshed.accessToken;
}

function buildUrl(path, query, { requestId, method } = {}) {
  const base = `${retailQboConfig.apiBaseUrl}/v3/company/${retailQboConfig.realmId}`;
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("minorversion", retailQboConfig.minorVersion);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  if (requestId && method !== "GET") {
    url.searchParams.set("requestid", requestId);
  }
  return url.toString();
}

async function rawRequest({ method, path, query, body, contentType, requestId, retryOn401 = true }) {
  const accessToken = await getAccessToken();
  const url = buildUrl(path, query, { requestId, method });

  console.log(`\n[Retail-QBO →] ${method} ${path}${requestId ? ` (requestid=${requestId})` : ""}`);
  if (body) console.log(`              body: ${truncate(JSON.stringify(body), 1000)}`);

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
      throw new TransientError(`Retail QBO ${method} ${path} non-JSON (${res.status})`, {
        status: res.status,
        body: text,
      });
    }
    json = null;
  }

  console.log(`[Retail-QBO ←] ${method} ${path}  status=${res.status}  ${elapsedMs}ms`);
  if (!res.ok || process.env.LOG_PRETTY === "true") {
    console.log(`              response: ${truncate(text, 1500)}`);
  }

  if (res.status === 401 && retryOn401) {
    log.warn("token.invalid_retry", { path });
    const doc = await readTokenDoc();
    if (doc) await refreshAccessToken(doc.refreshToken);
    return rawRequest({ method, path, query, body, contentType, requestId, retryOn401: false });
  }

  if (!res.ok) {
    const fault = json?.Fault || json?.fault;
    const errorDetail = fault?.Error?.[0] || fault?.error?.[0];
    const baseMsg =
      errorDetail?.Message || errorDetail?.message || `Retail QBO ${method} ${path} failed: ${res.status}`;
    const detail = errorDetail?.Detail || errorDetail?.detail;
    const msg = detail ? `${baseMsg}: ${detail}` : baseMsg;
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError;
    throw new ErrorClass(msg, { status: res.status, body: json ?? text });
  }

  return json;
}

export async function qboRetailRequest(opts) {
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

// Same auth + 401-retry-once dance as rawRequest, but returns raw bytes for
// non-JSON endpoints (e.g. /invoice/<id>/pdf, which returns a PDF stream).
// Keeps PDF transport inside services/retailQbo so the retail realm's QBO I/O
// stays in one place. Mirrors the wholesale binary client.
async function rawBinaryRequest({ path, accept, retryOn401 = true }) {
  const accessToken = await getAccessToken();
  const url = buildUrl(path);

  console.log(`\n[Retail-QBO →] GET ${path}  (binary, accept=${accept})`);
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: accept, Authorization: `Bearer ${accessToken}` },
  });
  const elapsedMs = Date.now() - startedAt;
  console.log(`[Retail-QBO ←] GET ${path}  status=${res.status}  ${elapsedMs}ms`);

  if (res.status === 401 && retryOn401) {
    log.warn("token.invalid_retry", { path });
    const doc = await readTokenDoc();
    if (doc) await refreshAccessToken(doc.refreshToken);
    return rawBinaryRequest({ path, accept, retryOn401: false });
  }

  if (!res.ok) {
    const text = await res.text();
    const ErrorClass = res.status >= 500 || res.status === 429 ? TransientError : PermanentError;
    throw new ErrorClass(`Retail QBO GET ${path} failed: ${res.status}`, {
      status: res.status,
      body: truncate(text, 500),
    });
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get("content-type") || accept,
  };
}

export async function qboRetailGetBinary(path, { accept = "application/octet-stream" } = {}) {
  return retry(() => rawBinaryRequest({ path, accept }), {
    attempts: RETRY.attempts,
    baseMs: RETRY.baseMs,
    maxMs: RETRY.maxMs,
    onAttempt: ({ attempt, err, nextDelayMs }) => {
      log.warn("binary.retry", { attempt, nextDelayMs, err });
    },
  });
}

// Convenience helpers used by retailQbo.service.js.
export const retailQbo = {
  get: (path, query) => qboRetailRequest({ method: "GET", path, query }),
  post: (path, body, query, opts = {}) =>
    qboRetailRequest({ method: "POST", path, body, query, requestId: opts.requestId }),
  update: (path, body) => qboRetailRequest({ method: "POST", path, body }),
  query: (statement) => qboRetailRequest({ method: "GET", path: "/query", query: { query: statement } }),
};
