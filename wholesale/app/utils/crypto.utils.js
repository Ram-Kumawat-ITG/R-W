// Symmetric encryption helper for fields that must round-trip but are
// PII-sensitive (e.g., commission bank account numbers used for payout
// instructions). The key is derived from SHOPIFY_API_SECRET so rotating
// that secret invalidates all encrypted values.
//
// Format: `aesgcm:<iv-hex>:<tag-hex>:<ciphertext-hex>` (versioned via
// prefix so future schemes can coexist with legacy values).

import crypto from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // 96-bit IV recommended for GCM
const KEY_LEN = 32 // 256-bit key
const SCRYPT_SALT = 'ns-wholesale-field-encryption-v1'

let cachedKey = null

function getKey() {
  if (cachedKey) return cachedKey
  const secret = process.env.SHOPIFY_API_SECRET
  if (!secret) {
    throw new Error(
      'SHOPIFY_API_SECRET is required for field encryption. Set it before persisting commission bank details.',
    )
  }
  cachedKey = crypto.scryptSync(secret, SCRYPT_SALT, KEY_LEN)
  return cachedKey
}

export function encryptField(plain) {
  if (plain == null || plain === '') return null
  const key = getKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `aesgcm:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

export function decryptField(stored) {
  if (!stored || typeof stored !== 'string') return null
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== 'aesgcm') return null
  const [, ivHex, tagHex, ctHex] = parts
  try {
    const key = getKey()
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctHex, 'hex')),
      decipher.final(),
    ])
    return pt.toString('utf8')
  } catch {
    // Tampered / wrong key / corrupted ciphertext — caller decides how
    // to handle (treat as if no value was stored).
    return null
  }
}
