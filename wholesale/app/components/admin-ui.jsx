// Reusable admin-UI primitives — Polaris `s-*` web components wrapped
// in tiny React components so we can reuse them across multiple admin
// route files. Previously these were copy-pasted in each route.
//
// Styling rule (from CLAUDE.md): admin UI is Polaris-only — no `style={{}}`
// and no CSS classes in this file or the routes that consume it.

import {
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHOD_SHORT,
} from "../utils/payment.constants";

// Label/value pair used throughout the admin detail pages. Renders the
// label as subdued small text above the value; empty / nullish values
// fall back to an em-dash placeholder so the grid stays aligned.
export function KV({ label, value }) {
  return (
    <s-stack direction="block" gap="none">
      <s-text tone="subdued">{label}</s-text>
      <s-text>{value || value === 0 ? value : "—"}</s-text>
    </s-stack>
  );
}

// Row in a totals box — label on the left, value on the right, both
// inline. `strong` flips the typography to bold for the grand-total
// row; `tone` lets the value render in success/critical colors when
// callers need to highlight a paid-off balance, etc.
export function TotalsRow({ label, value, strong, tone }) {
  return (
    <s-stack
      direction="inline"
      gap="base"
      alignItems="center"
      justifyContent="space-between"
    >
      <s-text tone={strong ? undefined : "subdued"}>
        {strong ? <strong>{label}</strong> : label}
      </s-text>
      <s-text tone={tone}>{strong ? <strong>{value}</strong> : value}</s-text>
    </s-stack>
  );
}

// ── Status badges ────────────────────────────────────────────────────
//
// Each badge is a thin lookup from an enum value to a Polaris tone +
// human label. Centralized here so the tone mapping is consistent
// across the Order List, Order Details, and any future admin page.

const PROCESSING_TONE_MAP = {
  received: { tone: "default", label: "Received" },
  processing: { tone: "info", label: "Processing" },
  pending_approval: { tone: "warning", label: "Pending approval" },
  rejected: { tone: "critical", label: "Rejected" },
  customer_ready: { tone: "info", label: "Customer ready" },
  invoiced: { tone: "info", label: "Invoiced" },
  scheduled: { tone: "info", label: "Scheduled" },
  completed: { tone: "success", label: "Completed" },
  failed: { tone: "critical", label: "Failed" },
};

// Renders a Shopify order's `processingStatus` — see `models/order.server.js`
// for the canonical enum.
export function ProcessingBadge({ status }) {
  const m =
    PROCESSING_TONE_MAP[status] || { tone: "default", label: status || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

const PAYMENT_STATUS_TONE_MAP = {
  pending: { tone: "warning", label: "Pending" },
  in_progress: { tone: "info", label: "In progress" },
  paid: { tone: "success", label: "Paid" },
  failed: { tone: "critical", label: "Failed" },
  cancelled: { tone: "default", label: "Cancelled" },
};

// Renders an Invoice's `paymentStatus` — see `models/invoice.server.js`.
export function PaymentStatusBadge({ status }) {
  const m =
    PAYMENT_STATUS_TONE_MAP[status] || { tone: "default", label: status || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

const PAYMENT_METHOD_TONE_MAP = {
  card: { tone: "info", label: PAYMENT_METHOD_LABEL.card },
  check: { tone: "default", label: PAYMENT_METHOD_LABEL.check },
  ach: { tone: "default", label: PAYMENT_METHOD_LABEL.ach },
};

// Renders an Invoice's `paymentMethod` (current active) or the
// `customerPaymentPreference` snapshot. The label uses
// PAYMENT_METHOD_LABEL so it stays consistent with the long-form copy
// used in other places (KVs, modals).
export function PaymentMethodBadge({ method }) {
  const m =
    PAYMENT_METHOD_TONE_MAP[method] || { tone: "default", label: method || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

const OUTCOME_TONE_MAP = {
  approved: { tone: "success", label: "Approved" },
  declined: { tone: "critical", label: "Declined" },
  error: { tone: "critical", label: "Error" },
  skipped: { tone: "default", label: "Skipped" },
  manual_paid: { tone: "success", label: "Manual paid" },
};

// Renders a `PaymentAttempt.outcome` — see `models/paymentAttempt.server.js`.
export function OutcomeBadge({ outcome }) {
  const m =
    OUTCOME_TONE_MAP[outcome] || { tone: "default", label: outcome || "—" };
  return <s-badge tone={m.tone}>{m.label}</s-badge>;
}

// ── Plain-text payment-method cells ─────────────────────────────────
//
// Used in list-page table cells where a badge would be visually too
// heavy. Compact label, subdued tone when there's nothing to show.

export function PaymentMethodShortText({ method }) {
  if (!method) return <s-text tone="subdued">—</s-text>;
  return <s-text>{PAYMENT_METHOD_SHORT[method] || method}</s-text>;
}
