import zipRanges from '../data/us-zip-ranges.json'

async function fetchWithTimeout(url, ms = 4000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

// ── Local fallback ─────────────────────────────────────────────────────────

function isZipValidForStateLocal(zip, stateCode) {
  const ranges = zipRanges[stateCode] 
  if (!ranges) return true
  const digits = String(zip).replace(/\D/g, '')
  if (digits.length < 5) return true
  const prefix = parseInt(digits.slice(0, 3), 10)
  return ranges.some(([min, max]) => prefix >= min && prefix <= max)
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
  const digits = String(zip).replace(/\D/g, '')
  if (!digits || digits.length < 5) return { valid: true }

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/us/${digits.slice(0, 5)}`
    )
    if (res.status === 404) {
      return { valid: false, message: 'ZIP code not found — enter a valid US ZIP' }
    }
    if (res.ok) {
      const data = await res.json()
      const apiState = data?.places?.[0]?.['state abbreviation']
      if (apiState) {
        return apiState === stateCode
          ? { valid: true }
          : { valid: false, message: 'ZIP code does not match the selected state' }
      }
    }
  } catch {
    // fall through to local data
  }

  const localOk = isZipValidForStateLocal(digits, stateCode)
  return localOk
    ? { valid: true }
    : { valid: false, message: 'ZIP code does not match the selected state' }
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
  const trimmed = city.trim()
  if (!trimmed || trimmed.length < 2 || !stateCode) return { valid: true }

  const state = stateCode.toLowerCase()
  const cityParam = encodeURIComponent(trimmed.toLowerCase())

  try {
    const res = await fetchWithTimeout(
      `https://api.zippopotam.us/us/${state}/${cityParam}`
    )
    if (res.status === 404) {
      return { valid: false, message: 'City not found in the selected state' }
    }
    if (res.ok) return { valid: true }
  } catch {
    // API unavailable — skip validation
  }

  return { valid: true }
}
