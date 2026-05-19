import { useLoaderData } from 'react-router'
import { authenticate } from '../shopify.server'
import { listAllWebhookSubscriptions } from '../services/shopify/registerWebhooks.server'

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request)
  const subs = await listAllWebhookSubscriptions(admin)

  console.log(`\n========== Webhook subscriptions for ${session.shop} ==========`)
  if (subs.length === 0) {
    console.log('  (none registered)')
  } else {
    for (const s of subs) {
      console.log(`  ${s.topic.padEnd(35)} → ${s.endpoint?.callbackUrl || s.endpoint?.__typename}`)
    }
  }
  console.log('===============================================================\n')

  return {
    shop: session.shop,
    appUrl: process.env.SHOPIFY_APP_URL || '',
    subs,
  }
}

export default function Webhooks() {
  const { shop, appUrl, subs } = useLoaderData()
  return (
    <s-page>
      <s-section heading={`Webhook subscriptions for ${shop}`}>
        <s-paragraph>
          App URL: <code>{appUrl || '(SHOPIFY_APP_URL not set)'}</code>
        </s-paragraph>
        {subs.length === 0 ? (
          <s-banner tone="critical">
            No webhook subscriptions registered. orders/create webhooks will not fire.
            Check the dev console for registration errors and confirm protected
            customer data approval in the Partners dashboard.
          </s-banner>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Topic</s-table-header>
              <s-table-header>Callback</s-table-header>
              <s-table-header>Created</s-table-header>
            </s-table-header-row>
            {subs.map((s) => (
              <s-table-row key={s.id}>
                <s-table-cell>{s.topic}</s-table-cell>
                <s-table-cell>{s.endpoint?.callbackUrl || s.endpoint?.__typename}</s-table-cell>
                <s-table-cell>{s.createdAt}</s-table-cell>
              </s-table-row>
            ))}
          </s-table>
        )}
      </s-section>
    </s-page>
  )
}
