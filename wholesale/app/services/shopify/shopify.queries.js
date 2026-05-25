// Shopify Admin GraphQL queries.
//
// Strings only — no I/O, no client construction. The service layer
// (shopify.service.js) imports these and runs them against an `admin`
// client passed in by the caller.
//
// Keeping queries in their own file lets you grep one place for every
// query in the app and makes it obvious when a query needs API-version
// bumping.

export const QUERY_WEBHOOK_SUBSCRIPTIONS_BY_TOPIC = `#graphql
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
  }
`

export const QUERY_ALL_WEBHOOK_SUBSCRIPTIONS = `#graphql
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
  }
`

export const QUERY_CUSTOMER_TAGS = `#graphql
  query CustomerTags($id: ID!) {
    customer(id: $id) { id tags }
  }
`

export const QUERY_FILE_BY_ID = `#graphql
  query FileById($id: ID!) {
    node(id: $id) {
      ... on MediaImage { fileStatus image { url } }
      ... on GenericFile { fileStatus url }
    }
  }
`

