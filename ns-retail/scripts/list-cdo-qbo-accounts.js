/* eslint-env node */
// List the QuickBooks Online company's Chart of Accounts with their
// API Ids — so you can fill in the three payout-posting account env vars:
//   QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID  (an Expense account)
//   QBO_RETAIL_PAYMENT_ACCOUNT_ID             (a Bank account)
//   QBO_RETAIL_AP_ACCOUNT_ID                  (an Accounts Payable account)
//
// It also doubles as a "verify QBO connection" tool: on first run it
// seeds the cdo_qbo_tokens doc from QBO_RETAIL_REFRESH_TOKEN and refreshes,
// using the SAME token store + rotation the app's QBO client uses (so the
// two never desync).
//
// Prereq: set QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_RETAIL_REALM_ID
// / QBO_RETAIL_REFRESH_TOKEN in .env first.
//
// Run with:  npm run cdo:qbo-accounts

import mongoose from "mongoose";
import connectDB from "../app/db/mongo.server.js";
import CdoQboToken from "../app/models/cdoQboToken.server.js";

const BASE_URLS = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};
const OAUTH_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SAFETY_MS = 60 * 1000;

const cfg = {
  environment: process.env.QBO_ENVIRONMENT || "sandbox",
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  realmId: process.env.QBO_RETAIL_REALM_ID,
  refreshToken: process.env.QBO_RETAIL_REFRESH_TOKEN,
  apiBaseUrl: process.env.QBO_API_BASE_URL,
  minorVersion: process.env.QBO_MINOR_VERSION || "73",
};

// config key → env var name (the mapping is non-uniform: app-level creds use
// the bare QBO_ prefix, company-level values use QBO_RETAIL_).
const ENV_NAMES = {
  clientId: "QBO_CLIENT_ID",
  clientSecret: "QBO_CLIENT_SECRET",
  realmId: "QBO_RETAIL_REALM_ID",
  refreshToken: "QBO_RETAIL_REFRESH_TOKEN",
};

function fail(msg) {
  console.error(`\n[cdo-qbo-accounts] ${msg}\n`);
  process.exit(1);
}

// Throws an Error (with .invalidGrant) instead of exiting, so the caller
// can fall back to the .env refresh token when the stored one is stale.
async function refreshAccessToken(currentRefreshToken) {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token refresh returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const err = new Error(`Token refresh failed (${res.status}: ${json.error})`);
    err.invalidGrant = json.error === "invalid_grant";
    throw err;
  }
  const now = Date.now();
  const updated = await CdoQboToken.findOneAndUpdate(
    { realmId: cfg.realmId },
    {
      $set: {
        accessToken: json.access_token,
        accessTokenExpiresAt: new Date(now + (json.expires_in ?? 3600) * 1000),
        refreshToken: json.refresh_token,
        refreshTokenExpiresAt: new Date(now + (json.x_refresh_token_expires_in ?? 8726400) * 1000),
        tokenType: json.token_type || "bearer",
      },
    },
    { upsert: true, new: true },
  ).lean();
  return updated.accessToken;
}

async function getAccessToken() {
  let doc = await CdoQboToken.findOne({ realmId: cfg.realmId }).lean();
  if (!doc) {
    if (!cfg.refreshToken) {
      fail("No stored token and QBO_RETAIL_REFRESH_TOKEN is empty. Seed a refresh token from the Intuit OAuth Playground.");
    }
    console.log("[cdo-qbo-accounts] no stored token — seeding from QBO_RETAIL_REFRESH_TOKEN…");
    await CdoQboToken.findOneAndUpdate(
      { realmId: cfg.realmId },
      {
        $setOnInsert: {
          realmId: cfg.realmId,
          refreshToken: cfg.refreshToken,
          accessToken: "pending",
          accessTokenExpiresAt: new Date(0),
        },
      },
      { upsert: true, new: true },
    );
    doc = await CdoQboToken.findOne({ realmId: cfg.realmId }).lean();
  }
  const expiresAt = doc.accessTokenExpiresAt?.getTime?.() ?? 0;
  if (doc.accessToken && doc.accessToken !== "pending" && expiresAt - SAFETY_MS > Date.now()) {
    return doc.accessToken;
  }
  console.log("[cdo-qbo-accounts] refreshing access token…");
  try {
    return await refreshAccessToken(doc.refreshToken);
  } catch (err) {
    // Stored refresh token is stale. If .env carries a different (likely
    // fresher) one, try it before giving up — covers the setup case where
    // a bad token was seeded earlier and you've since pasted a new one.
    if (err.invalidGrant && cfg.refreshToken && cfg.refreshToken !== doc.refreshToken) {
      console.log("[cdo-qbo-accounts] stored refresh token rejected — retrying with QBO_RETAIL_REFRESH_TOKEN from .env…");
      try {
        return await refreshAccessToken(cfg.refreshToken);
      } catch (err2) {
        if (err2.invalidGrant) {
          fail("Refresh token expired/revoked — generate a fresh one in the Intuit OAuth Playground, paste it into QBO_RETAIL_REFRESH_TOKEN, and re-run.");
        }
        throw err2;
      }
    }
    if (err.invalidGrant) {
      fail(
        "Refresh token expired/revoked. Generate a fresh one in the Intuit OAuth Playground, set QBO_RETAIL_REFRESH_TOKEN in .env, then run `npm run cdo:qbo-accounts -- --reset` to clear the stored token and re-seed.",
      );
    }
    fail(err.message);
  }
}

async function main() {
  const missing = ["clientId", "clientSecret", "realmId", "refreshToken"].filter((k) => !cfg[k]);
  if (missing.length) {
    fail(
      `Missing env: ${missing.map((k) => ENV_NAMES[k]).join(", ")}. Fill these in .env first.`,
    );
  }

  await connectDB();

  // Escape hatch: clear the stored token so the next run re-seeds from
  // the current QBO_RETAIL_REFRESH_TOKEN in .env.
  if (process.argv.includes("--reset")) {
    const r = await CdoQboToken.deleteOne({ realmId: cfg.realmId });
    console.log(`[cdo-qbo-accounts] reset — cleared ${r.deletedCount} stored token doc. Re-run without --reset.`);
    await mongoose.connection.close();
    return;
  }

  const accessToken = await getAccessToken();
  const apiBase = cfg.apiBaseUrl || BASE_URLS[cfg.environment];

  const query = "SELECT Id, Name, AccountType, AccountSubType, Active FROM Account MAXRESULTS 1000";
  const url = `${apiBase}/v3/company/${cfg.realmId}/query?query=${encodeURIComponent(query)}&minorversion=${cfg.minorVersion}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) fail(`Account query failed (${res.status}): ${text.slice(0, 400)}`);
  const accounts = JSON.parse(text)?.QueryResponse?.Account || [];

  console.log(`\n[cdo-qbo-accounts] ${cfg.environment} realm ${cfg.realmId} — ${accounts.length} account(s)\n`);

  // Group by AccountType; flag the three types the payout engine needs.
  const NEEDED = {
    Expense: "QBO_RETAIL_COMMISSION_EXPENSE_ACCOUNT_ID",
    Bank: "QBO_RETAIL_PAYMENT_ACCOUNT_ID",
    "Accounts Payable": "QBO_RETAIL_AP_ACCOUNT_ID",
  };
  const byType = new Map();
  for (const a of accounts) {
    if (!byType.has(a.AccountType)) byType.set(a.AccountType, []);
    byType.get(a.AccountType).push(a);
  }
  const sortedTypes = [...byType.keys()].sort((a, b) => {
    const aw = NEEDED[a] ? 0 : 1;
    const bw = NEEDED[b] ? 0 : 1;
    return aw - bw || a.localeCompare(b);
  });
  for (const type of sortedTypes) {
    const tag = NEEDED[type] ? `   ← ${NEEDED[type]}` : "";
    console.log(`${type}${tag}`);
    for (const a of byType.get(type)) {
      const inactive = a.Active === false ? " (inactive)" : "";
      console.log(`    Id=${String(a.Id).padEnd(5)} ${a.Name}${a.AccountSubType ? `  [${a.AccountSubType}]` : ""}${inactive}`);
    }
    console.log("");
  }

  console.log("Copy the relevant Ids into .env:");
  for (const [type, envVar] of Object.entries(NEEDED)) {
    const first = byType.get(type)?.find((a) => a.Active !== false);
    console.log(`  ${envVar}=${first ? first.Id : "<no " + type + " account found — create one in QBO>"}`);
  }
  console.log("");

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("[cdo-qbo-accounts] failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
