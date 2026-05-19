import {
  SAME_AS_BILLING,
  PROPERTY_TYPE_KEY,
  CREDENTIAL_MAP,
  REFERRAL_MAP,
} from "./shopifyNoteMap"

// Composes the customer's note in the exact "Key: Value\n" format the spec
// requires. Booleans render as "True" / "False" (Python casing). URLs render
// as-is. License lines only appear when a file URL is present for that
// credential. No JSON, no blank lines, no trailing newline.
export function buildShopifyNote(application = {}) {
  const lines = []

  const sameAsBilling = application.shippingSameAsBilling === true
  lines.push(`${SAME_AS_BILLING.true}: ${pyBool(sameAsBilling)}`)
  lines.push(`${SAME_AS_BILLING.false}: ${pyBool(!sameAsBilling)}`)

  const propertyType = sameAsBilling
    ? null
    : application.shippingAddress?.type || application.shippingPropertyType
  lines.push(`${PROPERTY_TYPE_KEY}: ${propertyType || ""}`)

  const creds = application.credentials || {}
  // Credential booleans first
  for (const c of CREDENTIAL_MAP) {
    const selected = creds[c.id]?.selected === true
    lines.push(`${c.credKey}: ${pyBool(selected)}`)
  }
  // Then license URLs for credentials that have one stored
  for (const c of CREDENTIAL_MAP) {
    if (!c.fileKey) continue
    const fileVal = creds[c.id]?.[`file${c.fileIndex}`]
    if (typeof fileVal === "string" && fileVal.startsWith("http")) {
      lines.push(`${c.fileKey}: ${fileVal}`)
    }
  }

  const refs = application.referrals || {}
  for (const r of REFERRAL_MAP) {
    const selected = refs[r.id]?.selected === true
    lines.push(`${r.key}: ${pyBool(selected)}`)
  }

  return lines.join("\n")
}

function pyBool(v) {
  return v ? "True" : "False"
}
