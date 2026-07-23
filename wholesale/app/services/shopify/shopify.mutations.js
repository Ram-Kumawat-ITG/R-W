// Shopify Admin GraphQL mutations.
//
// Strings only — no I/O, no client construction. The service layer
// (shopify.service.js) imports these and runs them against an `admin`
// client passed in by the caller.

// ── Orders ───────────────────────────────────────────────────────────

export const MUTATION_ORDER_MARK_AS_PAID = `#graphql
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
        updatedAt
      }
      userErrors { field message }
    }
  }
`


// ── Webhooks ─────────────────────────────────────────────────────────

export const MUTATION_WEBHOOK_SUBSCRIPTION_CREATE = `#graphql
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      userErrors { field message }
      webhookSubscription { id }
    }
  }
`

// ── Customers ────────────────────────────────────────────────────────

export const MUTATION_CUSTOMER_CREATE = `#graphql
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`

export const MUTATION_CUSTOMER_SEND_INVITE = `#graphql
  mutation CustomerSendInvite($customerId: ID!, $email: EmailInput) {
    customerSendAccountInviteEmail(customerId: $customerId, email: $email) {
      customer { id }
      userErrors { field message }
    }
  }
`

export const MUTATION_CUSTOMER_UPDATE = `#graphql
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id tags }
      userErrors { field message }
    }
  }
`

export const MUTATION_CUSTOMER_DELETE = `#graphql
  mutation CustomerDelete($id: ID!) {
    customerDelete(input: { id: $id }) {
      deletedCustomerId
      userErrors { field message }
    }
  }
`

export const MUTATION_ORDER_DELETE = `#graphql
  mutation OrderDelete($orderId: ID!) {
    orderDelete(orderId: $orderId) {
      deletedId
      userErrors { field message }
    }
  }
`

// ── File uploads ─────────────────────────────────────────────────────

export const MUTATION_STAGED_UPLOADS_CREATE = `#graphql
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`

export const MUTATION_FILE_CREATE = `#graphql
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
      }
      userErrors { field message }
    }
  }
`

// Set an (app-owned) metafield. Used to mirror the practitioner's payment
// order-hold onto their Shopify customer so the cart/checkout validation
// Function can read it (Functions can't call our DB/API). The `$app:` reserved
// namespace makes the metafield owned by — and readable to — this app's
// Functions.
export const MUTATION_METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`

// Delete a metafield (used to CLEAR the order hold — absent metafield = no hold).
export const MUTATION_METAFIELD_DELETE = `#graphql
  mutation MetafieldDelete($input: MetafieldIdentifierInput!) {
    metafieldDelete: metafieldsDelete(metafields: [$input]) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }
`
