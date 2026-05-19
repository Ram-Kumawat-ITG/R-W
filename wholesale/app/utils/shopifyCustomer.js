// Thin GraphQL helpers around the Shopify Admin API customer operations.
// All callers must pass an `admin` GraphQL client obtained from either
// authenticate.admin(request) or unauthenticated.admin(shop).

// US 10-digit phone (what our schema stores) → E.164 (+1XXXXXXXXXX) for Shopify.
export function toE164US(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  if (digits.length > 0) return `+${digits}`
  return null
}

function mapAddress(a) {
  if (!a) return null
  return {
    address1: a.line1 || "",
    address2: a.line2 || "",
    city: a.city || "",
    province: a.state || "",
    zip: a.zip || "",
    country: a.country || "",
  }
}

export async function customerCreate(admin, { application, note, tags = ["Pending"], subscribeNews = false }) {
  const addresses = []
  if (application.billingAddress) {
    addresses.push({
      ...mapAddress(application.billingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
      phone: toE164US(application.phone),
    })
  }
  if (!application.shippingSameAsBilling && application.shippingAddress) {
    addresses.push({
      ...mapAddress(application.shippingAddress),
      firstName: application.firstName,
      lastName: application.lastName,
      phone: toE164US(application.phone),
    })
  }

  const input = {
    email: application.email,
    firstName: application.firstName,
    lastName: application.lastName,
    tags,
    note,
    addresses,
    emailMarketingConsent: {
      marketingState: subscribeNews ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED',
      marketingOptInLevel: subscribeNews ? 'SINGLE_OPT_IN' : null,
      consentUpdatedAt: new Date().toISOString(),
    },
  }

  const res = await admin.graphql(
    `#graphql
    mutation CustomerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    { variables: { input } }
  )
  const json = await res.json()
  const errs = json?.data?.customerCreate?.userErrors
  if (errs?.length) throw new Error(errs.map((e) => `[${Array.isArray(e.field) ? e.field.join('.') : e.field}] ${e.message}`).join("; "))
  const id = json?.data?.customerCreate?.customer?.id
  if (!id) throw new Error("customerCreate returned no customer")
  return id
}

export async function customerSendInvite(admin, { customerId, subject, message, fromEmail }) {
  const emailInput = {}
  if (subject) emailInput.subject = subject
  if (message) emailInput.customMessage = message
  if (fromEmail) emailInput.from = fromEmail

  const res = await admin.graphql(
    `#graphql
    mutation CustomerSendInvite($customerId: ID!, $email: CustomerEmailInput) {
      customerSendAccountInviteEmail(customerId: $customerId, email: $email) {
        customer { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        customerId,
        email: Object.keys(emailInput).length ? emailInput : null,
      },
    }
  )
  const json = await res.json()
  const errs = json?.data?.customerSendAccountInviteEmail?.userErrors
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "))
  return true
}

// Returns the GID of the first Shopify customer matching the email, or null if not found.
export async function customerFindByEmail(admin, email) {
  const res = await admin.graphql(
    `#graphql
    query CustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id } }
      }
    }`,
    { variables: { query: `email:${email}` } }
  )
  const json = await res.json()
  return json?.data?.customers?.edges?.[0]?.node?.id ?? null
}

// Swap one tag for another on a Shopify customer.
// Reads current tags, removes `removeTag`, adds `addTag`, writes back.
export async function customerUpdateTags(admin, { customerId, addTag, removeTag }) {
  const readRes = await admin.graphql(
    `#graphql
    query CustomerTags($id: ID!) {
      customer(id: $id) { id tags }
    }`,
    { variables: { id: customerId } }
  )
  const readJson = await readRes.json()
  const current = readJson?.data?.customer?.tags || []
  const next = Array.from(
    new Set([...current.filter((t) => t !== removeTag), addTag])
  )

  const writeRes = await admin.graphql(
    `#graphql
    mutation CustomerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id tags }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: customerId, tags: next } } }
  )
  const writeJson = await writeRes.json()
  const errs = writeJson?.data?.customerUpdate?.userErrors
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "))
  return writeJson?.data?.customerUpdate?.customer?.tags || next
}

export async function customerUpdateNote(admin, { customerId, note }) {
  const res = await admin.graphql(
    `#graphql
    mutation CustomerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: customerId, note } } }
  )
  const json = await res.json()
  const errs = json?.data?.customerUpdate?.userErrors
  if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '))
  return true
}

export async function customerDelete(admin, customerId) {
  const res = await admin.graphql(
    `#graphql
    mutation CustomerDelete($id: ID!) {
      customerDelete(input: { id: $id }) {
        deletedCustomerId
        userErrors { field message }
      }
    }`,
    { variables: { id: customerId } }
  )
  const json = await res.json()
  const errs = json?.data?.customerDelete?.userErrors
  if (errs?.length) throw new Error(errs.map((e) => e.message).join("; "))
  return true
}
