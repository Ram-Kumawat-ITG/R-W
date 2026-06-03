/* eslint-env node */
// Generic env var reading helpers used by per-service config files.
// Centralizing these means every service config validates the same way.
// (Mirrors the wholesale workspace's env.utils so the CDO QBO client can
// follow the same "no process.env outside config" discipline.)

export function readEnv(key, { required = false, fallback } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }
  return raw;
}

export function readInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return n;
}

export function readNumber(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
  }
  return n;
}

export function readBool(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw.toLowerCase() === "yes";
}
