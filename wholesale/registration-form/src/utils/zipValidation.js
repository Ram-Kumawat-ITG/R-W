import zipRanges from "../data/us-zip-ranges.json";
import countriesData from "../data/countries.json";

function getCountryCodeByName(name) {
  if (!name) return null;
  const country = countriesData.find((c) => c.name === name);
  return country?.code || null;
}

async function fetchWithTimeout(url, ms = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// ── Local fallback ─────────────────────────────────────────────────────────

function isZipValidForStateLocal(zip, stateCode) {
  const ranges = zipRanges[stateCode];
  if (!ranges) return true;
  const digits = String(zip).replace(/\D/g, "");
  if (digits.length < 5) return true;
  const prefix = parseInt(digits.slice(0, 3), 10);
  return ranges.some(([min, max]) => prefix >= min && prefix <= max);
}

// ── ZIP validation ─────────────────────────────────────────────────────────

/**
 * Validate a US ZIP code against a state code.
 * Returns { valid: true } or { valid: false, message }.
 *
 * 1. Zippopotam API — exact match.
 * 2. On failure → local prefix-range JSON.
 * 3. No local data for state → pass through.
 */
export async function validateZipForState(zip, stateCode) {
  const digits = String(zip).replace(/\D/g, "");
  if (!digits || digits.length < 5) return { valid: true };

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/us/${digits.slice(0, 5)}`,
    );
    if (res.status === 404) {
      return {
        valid: false,
        message: "ZIP code not found — enter a valid US ZIP",
      };
    }
    if (res.ok) {
      const data = await res.json();
      const apiState = data?.places?.[0]?.["state abbreviation"];
      if (apiState) {
        return apiState === stateCode
          ? { valid: true }
          : {
              valid: false,
              message: "ZIP code does not match the selected state",
            };
      }
    }
  } catch {
    // fall through to local data
  }

  const localOk = isZipValidForStateLocal(digits, stateCode);
  return localOk
    ? { valid: true }
    : { valid: false, message: "ZIP code does not match the selected state" };
}

// ── ZIP validation (non-US, country-aware) ─────────────────────────────────

/**
 * Validate a postal code for any country supported by Zippopotam.
 * Returns { valid: true } or { valid: false, message }.
 *
 * Strategy:
 * 1. Look up the ISO 2-letter country code by name.
 * 2. Hit api.zippopotam.us/{code}/{zip}.
 *    - 200 → ZIP exists. If a stateCode is supplied, verify it matches one
 *      of the API's "state abbreviation" values for the returned places.
 *    - 404 → ZIP not found for that country → invalid.
 * 3. Any network/timeout error → pass through (don't block on outages).
 *
 * Countries not supported by Zippopotam return 404; the user sees an
 * "invalid" error. That's acceptable here — the storefront primarily ships
 * to Zippopotam-supported countries and false negatives are rarer than
 * accidental garbage input.
 */
export async function validateZipForCountry(zip, countryName, stateCode) {
  const trimmed = String(zip || "").trim();
  if (!trimmed || !countryName) return { valid: true };

  const code = getCountryCodeByName(countryName);
  if (!code) return { valid: true };

  if (countryName === "United States") {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 5) return null;
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/${code.toLowerCase()}/${encodeURIComponent(trimmed)}`,
    );
    if (res.status === 404) {
      return {
        valid: false,
        message: "Postal code not found for the selected country",
      };
    }
    if (res.ok) {
      if (stateCode) {
        const data = await res.json();
        const apiStates = (data?.places || [])
          .map((p) => p?.["state abbreviation"])
          .filter(Boolean);
        if (apiStates.length > 0 && !apiStates.includes(stateCode)) {
          return {
            valid: false,
            message: "Postal code does not match the selected state",
          };
        }
      }
      return { valid: true };
    }
  } catch {
    // API outage / network failure — don't block the user
  }
  return { valid: true };
}

// ── ZIP → place lookup (autofill helper) ───────────────────────────────────

/**
 * Look up the primary place (city + state) for a postal code.
 * Returns { city, state } or null. Designed for autofill — silently
 * returns null on 404, network errors, or unsupported countries so the
 * caller can simply do `if (result?.city) setValue(...)`.
 */
export async function lookupPlaceForZip(zip, countryName) {
  const trimmed = String(zip || "").trim();
  if (!trimmed || !countryName) return null;

  const code = getCountryCodeByName(countryName);
  if (!code) return null;

  // For US we only call once we have a 5-digit prefix — avoids spamming
  // the API while the user is still typing.
  if (countryName === "United States") {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 5) return null;
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/${code.toLowerCase()}/${encodeURIComponent(trimmed)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const place = data?.places?.[0];
    if (!place) return null;
    return {
      city: place["place name"] || null,
      state: place["state abbreviation"] || null,
    };
  } catch {
    return null;
  }
}

// ── City validation ────────────────────────────────────────────────────────

/**
 * Validate that a city exists within a US state using Zippopotam's
 * city→zip endpoint: api.zippopotam.us/us/{state}/{city}
 *
 * Returns { valid: true } or { valid: false, message }.
 * Any API failure (network, timeout, rate-limit) returns { valid: true }
 * so the user is never blocked by an outage.
 */
export async function validateCityForState(city, stateCode) {
  const trimmed = city.trim();
  if (!trimmed || trimmed.length < 2 || !stateCode) return { valid: true };

  const state = stateCode.toLowerCase();
  const cityParam = encodeURIComponent(trimmed.toLowerCase());

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/us/${state}/${cityParam}`,
    );
    if (res.status === 404) {
      return { valid: false, message: "City not found in the selected state" };
    }
    if (res.ok) return { valid: true };
  } catch {
    // API unavailable — skip validation
  }

  return { valid: true };
}
