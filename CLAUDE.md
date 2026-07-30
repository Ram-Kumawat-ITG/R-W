# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

**[PROGRAM.md](PROGRAM.md)** is the canonical project index — read it at session start. It documents the repo layout, feature status tables, Grow-plan restrictions, and a running session changelog. Append an entry there at session end for any meaningful work.

For wholesale-specific deep work, also open:
- **[wholesale/CLAUDE.md](wholesale/CLAUDE.md)** — wholesale app spec, pipeline details, project laws, implementation status
- **[wholesale/INTEGRATIONS.md](wholesale/INTEGRATIONS.md)** — full technical reference for the Shopify → QBO → NMI pipeline (~1,400 lines)

## Repository layout

Two independently-deployable Shopify apps; each has its own `package.json`, `shopify.app.toml`, extensions, and Render deployment.

```
Natural-solutions/
├── ns-retail/          # Retail/CDO patient-facing store → https://r-w.onrender.com
└── wholesale/          # Wholesale B2B practitioner store → https://natural-solutions-wholesale.onrender.com
```

Both share **one MongoDB cluster** (`natural-solutions` database) but own distinct collections. There is no shared `node_modules` — treat them as separate workspaces.

## Commands

All commands run from within the app's directory. Node 20.19+ / 22.12+ required.

### ns-retail/

```bash
npm run dev              # shopify app dev with auto-tunnel (also runs sync:extension-app-url first)
npm run dev:local        # local dev using localhost tunnel
npm run build            # production build (react-router build)
npm run start            # serve prebuilt bundle
npm run deploy           # shopify app deploy (prebuilds signup form + client portal first)
npm run lint             # ESLint
npm run typecheck        # react-router typegen + tsc --noEmit
npm run build:signup     # build signup-form/ Vite app → theme-extension/assets/
npm run build:practitioner-code  # build practitioner-code-form/ Vite app → theme-extension/assets/
npm run build:client-portal      # build client-portal/ Vite app → theme-extension/assets/
```

### wholesale/

```bash
npm run dev              # shopify app dev with auto-tunnel
npm run dev:local        # local dev using localhost tunnel
npm run build            # production build (react-router build)
npm run start            # serve prebuilt bundle
npm run deploy           # shopify app deploy (prebuilds theme forms first via predeploy)
npm run lint             # ESLint
npm run typecheck        # react-router typegen + tsc --noEmit
npm run build:theme      # build all theme sub-apps (signup, client-portal, practitioner-code)
npm run config:use <profile>   # switch shopify.app.*.toml profiles (e.g. staging, production)
```

There are no automated test suites in either app — verification is done via `shopify app dev` against staging stores.

## Architecture

### Tech stack (both apps)

- **React Router 7** (Remix-style file-based routing, SSR)
- **MongoDB** via Mongoose (business data + Shopify session storage)
- **Prisma** (ns-retail only, secondary session storage)
- **Shopify App SDK** (`@shopify/shopify-app-react-router`)
- **Shopify API version**: `2026-07`

### Route structure

File-based flat routes under `app/routes/`:
- `app.*.jsx` — authenticated Shopify admin routes (embedded app)
- `webhooks.*.jsx` — unauthenticated webhook handlers (HMAC-validated)
- `api/` — public endpoints (app proxy, carrier service callbacks, theme form APIs)

Additional routes registered manually in `app/routes.js` for API handlers that don't follow file-based naming.

**Typical route pattern**:
```javascript
// Server-side loader/action (authenticate first)
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);
  return { data };
}

export async function action({ request }) {
  const { admin } = await shopify.authenticate.admin(request);
  return { result };
}

// Client component
export default function Page() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  return <Page>...</Page>;
}
```

### Service layer

Both apps split domain logic under `app/services/<domain>/`:
- `<domain>.config.js` — env reads (server-only; use `readEnv`/`readInt`/`readBool` — no raw `process.env` elsewhere)
- `<domain>.service.js` — business logic (server-only)
- `<domain>.apis.js` — HTTP transport (server-only)
- `<domain>.utils.js` — pure helpers (isomorphic, safe to import on client)

**Never import `.service.js` or `.config.js` from client render code** — they contain `process.env` and Node APIs that would leak into the browser bundle.

### Theme sub-apps (both apps)

Each app has standalone Vite + React sub-apps that compile into the theme extension's `assets/` folder so they can be loaded as storefront blocks:

| App | Sub-apps |
|---|---|
| ns-retail | `signup-form/`, `practitioner-code-form/`, `client-portal/` |
| wholesale | `registration-form/`, `client-portal/`, `practitioner-code-form/` |

Build each with `npm run build` from inside the sub-app folder, or use the convenience script from the parent app (`build:signup`, `build:theme`, etc.).

### Grow-plan restrictions (critical)

Both stores run on **Shopify Grow plan**. The following are **Plus-only and silently do nothing on Grow**:
- Checkout UI extensions on info/shipping/payment steps
- Cart Transform Function price overrides (`lineUpdate`)
- Custom Shopify Functions (Discount, Delivery, Payment, Cart Transform)

**What works on Grow**: theme app extension blocks (cart page), customer account UI extensions, carrier service API, webhooks, Admin API, automatic discounts.

When adding features, always check the Grow-plan table in PROGRAM.md before using checkout extensions or Shopify Functions.

### ns-retail: CDO program

The retail app's core feature is the CDO (Customer Direct Order) practitioner-referral program:
- Practitioners give patients referral codes → patients enter code on cart page → discount applied + commission tracked
- Key endpoint: `app/api/shipping/rates.js` — carrier service callback that also computes the 3% processing fee bundled into shipping rates
- Key collections: `cdo_applications`, `cdo_practitioner_codes`, `cdo_orders`, `cdo_commissions`
- Shipping fee detail is documented in `ns-retail/SHIPPING_LOGIC.md`

### wholesale: order-to-payment pipeline

The wholesale app's critical path: Shopify order → QBO invoice → NMI charge

```
webhooks.orders.create.jsx
  → order.service.js  (idempotent orchestrator)
      → customer.service.js  (QBO customer + NMI vault)
      → invoice.service.js   (claim-first insert → QBO invoice)
  → Agenda scheduler
      → processPendingPayments.job.js
          PASS 1: payment.service.chargeInvoice  (NMI)
          PASS 2: invoice.service.propagateSuccessfulPayment
```

Three idempotency layers prevent duplicate invoices — see wholesale/CLAUDE.md for details.

## Deployment

| App | Platform | URL |
|---|---|---|
| ns-retail | Render | https://r-w.onrender.com |
| wholesale | Render | https://natural-solutions-wholesale.onrender.com |

MongoDB Atlas requires IP allowlist `0.0.0.0/0` for Render's dynamic IPs. Env vars are set in the Render dashboard (not committed).
