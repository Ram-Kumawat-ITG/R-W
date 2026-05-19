// Barrel re-export for the admin API group.
//
// React Router still loads each route from its individual file path via
// `app/routes.js` (it needs a per-route module so loader/action symbols
// don't collide). This barrel exists for consumers that want to reference
// the group programmatically — e.g. tests, introspection, or future
// route-config refactors.
//
// Usage:
//   import * as admin from '~/api/admin'
//   admin.customer.loader     // GET  /api/admin/customers/:id
//   admin.customers.loader    // GET  /api/admin/customers
//   admin.review.action       // POST /api/admin/customers/:id/review
//   admin.unreview.action     // POST /api/admin/customers/:id/unreview
//   admin.decline.action      // POST /api/admin/customers/:id/decline

export * as customer from './customer'
export * as customers from './customers'
export * as review from './review'
export * as unreview from './unreview'
export * as decline from './decline'
