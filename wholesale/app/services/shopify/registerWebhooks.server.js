import { createLogger } from '../logger.server'

const log = createLogger('shopify.webhooks')

// Topics that we cannot declare in shopify.app.toml because they
// contain protected customer data and require Partners approval. We
// register them programmatically via the Admin GraphQL API after the
// merchant has installed and granted the necessary scopes.
//
// Add new protected-topic subscriptions here as the app grows.
const REQUIRED_SUBSCRIPTIONS = [
  {
    topic: 'ORDERS_CREATE',
    callbackPath: '/webhooks/orders/create',
  },
]

// In-memory guard so a busy admin session doesn't spam the existence
// check on every loader. Keyed by shop domain.
const registered = new Set()

function callbackUrl(callbackPath) {
  const base = process.env.SHOPIFY_APP_URL
  if (!base) throw new Error('SHOPIFY_APP_URL not set; cannot build webhook callback URL')
  return `${base.replace(/\/$/, '')}${callbackPath}`
}

async function existingSubscriptions(admin, topic) {
  const res = await admin.graphql(
    `#graphql
    query SubsByTopic($topics: [WebhookSubscriptionTopic!]) {
      webhookSubscriptions(first: 50, topics: $topics) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
        }
      }
    }`,
    { variables: { topics: [topic] } },
  )
  const json = await res.json()
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || []
}

async function createSubscription(admin, { topic, callbackPath }) {
  const url = callbackUrl(callbackPath)
  const res = await admin.graphql(
    `#graphql
    mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        userErrors { field message }
        webhookSubscription { id }
      }
    }`,
    {
      variables: {
        topic,
        sub: { callbackUrl: url, format: 'JSON' },
      },
    },
  )
  const json = await res.json()
  const userErrors = json?.data?.webhookSubscriptionCreate?.userErrors || []
  if (userErrors.length) {
    // Most likely cause in dev: "not approved for protected customer data".
    throw new Error(
      `webhookSubscriptionCreate(${topic}): ${userErrors.map((e) => e.message).join('; ')}`,
    )
  }
  return json?.data?.webhookSubscriptionCreate?.webhookSubscription?.id
}

// Idempotently ensure every required subscription is registered. Safe
// to call on every authenticated admin request — most invocations are
// in-memory no-ops once registration has succeeded once per process.
//
// Failures are logged but never thrown to the caller, so a missing
// Partners approval doesn't break the embedded admin UI.
export async function ensureProtectedWebhooks({ admin, shop }) {
  if (!shop || !admin) return
  if (registered.has(shop)) return

  console.log(`\n========== Webhook registration check: ${shop} ==========`)
  for (const sub of REQUIRED_SUBSCRIPTIONS) {
    try {
      const desiredUrl = callbackUrl(sub.callbackPath)
      const existing = await existingSubscriptions(admin, sub.topic)
      const match = existing.find((s) => s.endpoint?.callbackUrl === desiredUrl)
      if (match) {
        console.log(`  [OK]      ${sub.topic} already subscribed → ${desiredUrl}`)
        log.info('subscription.present', { shop, topic: sub.topic, url: desiredUrl })
        continue
      }
      const id = await createSubscription(admin, sub)
      console.log(`  [CREATED] ${sub.topic} → ${desiredUrl}  (id=${id})`)
      log.info('subscription.created', { shop, topic: sub.topic, id, url: desiredUrl })
    } catch (err) {
      console.log(`  [FAILED]  ${sub.topic}: ${err.message}`)
      console.log('            → This usually means the app is not approved for')
      console.log('              protected customer data. Approve in Partners dashboard:')
      console.log('              Partners → your app → API access → Protected customer data')
      log.warn('subscription.skipped', { shop, topic: sub.topic, reason: err.message })
    }
  }
  console.log('=========================================================\n')

  registered.add(shop)
}

// List every webhook subscription registered for this shop (regardless
// of topic). Used by the /app/webhooks diagnostic page.
export async function listAllWebhookSubscriptions(admin) {
  const res = await admin.graphql(
    `#graphql
    query AllSubs {
      webhookSubscriptions(first: 100) {
        edges {
          node {
            id
            topic
            createdAt
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
        }
      }
    }`,
  )
  const json = await res.json()
  return json?.data?.webhookSubscriptions?.edges?.map((e) => e.node) || []
}
