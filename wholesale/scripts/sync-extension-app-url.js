// scripts/sync-extension-app-url.js
//
// Bakes the current app URL into the Customer Account UI extension's HTTP
// client (extensions/services/FullPageApi.jsx → `const SERVER_URL = "..."`).
//
// WHY THIS EXISTS
// ---------------
// The profile-update extension is a Customer Account UI extension that runs in
// a Web Worker sandbox. That sandbox has NO `process.env`, so the absolute
// backend URL it fetch()es (`${SERVER_URL}/api/portal/profile`) cannot be read
// from the environment at runtime — it must be hardcoded into the source
// before the extension is bundled. This script keeps that hardcoded value in
// sync with the app's real URL so we don't have to hand-edit it every time the
// dev tunnel rotates or we deploy.
//
// It runs automatically from the `predev` and `predeploy` npm hooks.
//
// URL RESOLUTION (first match wins)
//   1. CLI argument:           node scripts/sync-extension-app-url.js https://my-url
//   2. process.env.SHOPIFY_APP_URL
//   3. SHOPIFY_APP_URL in wholesale/.env   (the Shopify CLI rewrites this each
//                                           `shopify app dev` session)
//   4. application_url in the active shopify.app*.toml
//
// KNOWN LIMITATION
//   `predev` runs BEFORE `shopify app dev` boots, so on the very first run of a
//   session the tunnel URL for THIS session isn't known yet — we bake in the
//   last-known URL from .env. If the trycloudflare tunnel rotates, re-run
//   `npm run sync:extension-app-url` once the new URL is printed (or set a
//   stable URL via ngrok / SHOPIFY_APP_URL) and restart the extension.
//
// This script never hard-fails the dev/deploy pipeline: if it can't resolve a
// URL it warns and exits 0, leaving the existing baked value untouched.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TARGET_FILE = path.join(ROOT, "extensions", "services", "FullPageApi.jsx");
const ENV_FILE = path.join(ROOT, ".env");

const TAG = "[sync-extension-app-url]";

/** Read a single key from a .env file without pulling in a dotenv dependency.
 * Returns the LAST occurrence so the result matches what `dotenv` does at
 * server boot — Shopify CLI sometimes appends new SHOPIFY_APP_URL lines on
 * tunnel rotation instead of overwriting, leaving stale entries in place. */
function readEnvFile(key) {
  if (!fs.existsSync(ENV_FILE)) return null;
  const text = fs.readFileSync(ENV_FILE, "utf8");
  let lastValue = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) lastValue = value;
  }
  return lastValue;
}

/** Pull `application_url` out of the active shopify.app*.toml (default config first). */
function readTomlApplicationUrl() {
  const candidates = [
    path.join(ROOT, "shopify.app.toml"),
    ...fs
      .readdirSync(ROOT)
      .filter((f) => /^shopify\.app\..+\.toml$/.test(f))
      .map((f) => path.join(ROOT, f)),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/^\s*application_url\s*=\s*["']([^"']+)["']/m);
    if (match && match[1]) return match[1];
  }
  return null;
}

/** Normalize: trim, drop trailing slashes, validate http(s). Returns null if invalid. */
function normalizeUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/i.test(trimmed)) return null;
  return trimmed;
}

function resolveAppUrl() {
  const argUrl = process.argv[2];
  const candidates = [
    ["CLI argument", argUrl],
    ["process.env.SHOPIFY_APP_URL", process.env.SHOPIFY_APP_URL],
    [".env SHOPIFY_APP_URL", readEnvFile("SHOPIFY_APP_URL")],
    ["shopify.app*.toml application_url", readTomlApplicationUrl()],
  ];
  for (const [source, value] of candidates) {
    const url = normalizeUrl(value);
    if (url) return { url, source };
  }
  return { url: null, source: null };
}

function main() {
  const { url, source } = resolveAppUrl();

  if (!url) {
    console.warn(
      `${TAG} Could not resolve an app URL (checked CLI arg, env, .env, *.toml). ` +
        `Leaving ${path.relative(ROOT, TARGET_FILE)} untouched.`,
    );
    return; // exit 0 — never block dev/deploy
  }

  if (!fs.existsSync(TARGET_FILE)) {
    console.warn(
      `${TAG} Target ${path.relative(ROOT, TARGET_FILE)} not found — nothing to sync.`,
    );
    return; // exit 0 — extension may have been removed/renamed
  }

  const original = fs.readFileSync(TARGET_FILE, "utf8");

  // Match: const SERVER_URL = "<anything>"   (keep any trailing `|| process.env...`)
  const re = /(const\s+SERVER_URL\s*=\s*)(["'])(.*?)\2/;
  const found = original.match(re);

  if (!found) {
    console.warn(
      `${TAG} Could not find a \`const SERVER_URL = "..."\` declaration in ` +
        `${path.relative(ROOT, TARGET_FILE)} — skipping.`,
    );
    return; // exit 0 — don't block the pipeline on a refactor
  }

  const current = found[3];
  if (current === url) {
    console.log(`${TAG} SERVER_URL already set to ${url} (via ${source}). No change.`);
    return;
  }

  const updated = original.replace(re, `$1"${url}"`);
  fs.writeFileSync(TARGET_FILE, updated, "utf8");
  console.log(
    `${TAG} Updated SERVER_URL in ${path.relative(ROOT, TARGET_FILE)}:\n` +
      `        ${current || "(empty)"}  →  ${url}\n` +
      `        (source: ${source})`,
  );
}

main();
