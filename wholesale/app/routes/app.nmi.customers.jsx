import { useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { listNmiCustomerVaults } from "../services/nmi/nmi.service";
// fromNmiDate lives in nmi.utils.js — see that file for why pure
// helpers are split out (avoids dragging process.env into the client
// bundle via nmi.config.js).
import { fromNmiDate } from "../services/nmi/nmi.utils";
import { AdvancedFilters } from "../components/admin-ui";

const PAGE_SIZE = 50;

// Map a customer vault row to a Card / ACH / Unknown payment method.
// NMI's customer_vault report carries either `cc_number` (masked PAN +
// `cc_type`) or `check_account` (masked ACH) depending on which payment
// method was attached at vault creation. Both being empty means the
// vault was created without a payment method (rare in this app — every
// vault is created with payment details at registration).
function methodMeta(c) {
  if (c.cc_number) {
    return {
      type: "card",
      label: "Card",
      detail:
        (c.cc_type ? c.cc_type.toUpperCase() : "Card") +
        " · " +
        (c.cc_number || ""),
    };
  }
  if (c.check_account) {
    return {
      type: "ach",
      label: "ACH",
      detail: `Bank · ${c.check_account}${c.account_type ? ` · ${c.account_type}` : ""}`,
    };
  }
  return { type: "none", label: "—", detail: "No payment method on file" };
}

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "card", label: "Card on file" },
  { id: "ach", label: "ACH on file" },
];

// Config for the shared <AdvancedFilters> card.
const FILTER_FIELDS = [
  {
    key: "q",
    label: "Search",
    type: "text",
    placeholder: "Name, email, phone, or vault id",
  },
  {
    key: "status",
    label: "Payment on file",
    type: "select",
    options: STATUS_FILTERS.map((s) => ({ value: s.id, label: s.label })),
  },
];
const FILTER_DEFAULTS = { status: "all" };

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));

  try {
    // NMI's customer_vault report supports an `email` filter. When the
    // search query looks like an email, send it through — otherwise we
    // fall back to a full-vault fetch and search client-side.
    const looksLikeEmail = /@/.test(q);
    const fetched = await listNmiCustomerVaults(
      looksLikeEmail ? { email: q } : {},
    );

    // Client-side filter: name / vault-id / phone substring. Loader runs
    // the cheap pass before pagination so the count reflects the
    // filtered set, not the raw fetch.
    const haystackMatch = (c) => {
      const needle = q.toLowerCase();
      const fields = [
        // Some gateway versions only expose `id` (Pattern C), others use
        // `customer_vault_id` — match both.
        c.customer_vault_id,
        c.id,
        c.first_name,
        c.last_name,
        `${c.first_name || ""} ${c.last_name || ""}`.trim(),
        c.email,
        c.phone,
        c.company,
      ];
      return fields.some((v) => (v || "").toLowerCase().includes(needle));
    };

    const filtered = fetched.records.filter((c) => {
      if (status === "card" && !c.cc_number) return false;
      if (status === "ach" && !c.check_account) return false;
      if (q && !looksLikeEmail) return haystackMatch(c);
      return true;
    });

    const total = filtered.length;
    const startIdx = (page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(startIdx, startIdx + PAGE_SIZE);

    return {
      rows: pageRows.map(projectCustomer),
      total,
      page,
      pageSize: PAGE_SIZE,
      q,
      status,
      error: null,
      // Forward the service-layer diagnostic so the UI can distinguish
      // "vault genuinely empty" from "parser couldn't read the
      // response" (the latter is a bug — wrapper-element drift in
      // NMI's customer_vault report XML).
      debug: fetched.debug,
    };
  } catch (e) {
    console.error("[nmi/customers] loader failed:", e?.message || e);
    return {
      rows: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
      q,
      status,
      error: e?.message || "Failed to load NMI customers",
      debug: null,
    };
  }
};

function projectCustomer(c) {
  const method = methodMeta(c);
  const created = fromNmiDate(c.created);
  // NMI doesn't have a single "vault status" field on the customer_vault
  // report — every record returned IS active by definition (deleted
  // entries aren't included in the response). We surface "Active" by
  // default but flag missing-payment-method vaults as "Empty" since
  // those can't actually be charged.
  const status = method.type === "none" ? "Empty" : "Active";
  // Some gateway versions return `<customer_vault_id>` on each entry;
  // others expose only `<id>`. Prefer the explicit vault-id field but
  // fall back to id so Pattern C responses don't render rows with a
  // blank Vault ID column.
  const vaultId = c.customer_vault_id || c.id || null;
  return {
    id: vaultId,
    firstName: c.first_name || null,
    lastName: c.last_name || null,
    email: c.email || null,
    phone: c.phone || null,
    company: c.company || null,
    methodType: method.type,
    methodLabel: method.label,
    methodDetail: method.detail,
    createdAt: created ? created.toISOString() : null,
    status,
  };
}

export default function NmiCustomers() {
  const { rows, total, page, pageSize, q, status, error, debug } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showDebug, setShowDebug] = useState(false);

  const refreshing = revalidator.state !== "idle";
  const tableLoading = navigation.state === "loading" || refreshing;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  // Pagination only — filter navigation is owned by <AdvancedFilters>.
  const updateParams = (next) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "" || v === undefined) merged.delete(k);
      else merged.set(k, String(v));
    }
    if (!("page" in next)) merged.delete("page");
    setSearchParams(merged);
  };

  return (
    <>
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ q, status }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />
      <s-section heading={`Customer vault (${total})`}>
        <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Could not load customers">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        )}

        {/* Diagnostic banner for NMI response-shape problems.
            `errorMessage` is NMI's own <error_response>, which usually
            means a bad security key, malformed filter, or an account-
            level permission issue. `parserShapeMismatch` means NMI
            returned a non-trivial response but the regex parser
            couldn't find any vault entries — almost certainly a
            wrapper-element drift between gateway versions. Check the
            `[NMI query ←]` server console log for the raw response
            shape and adjust `parseNmiCustomerVaults` in nmi.utils.js. */}
        {debug?.errorMessage && (
          <s-banner tone="critical" heading="NMI returned an error">
            <s-paragraph>{debug.errorMessage}</s-paragraph>
            <s-paragraph tone="subdued">
              Verify the NMI security key + that the configured account has
              vault-read permission.
            </s-paragraph>
          </s-banner>
        )}
        {debug?.parserShapeMismatch && (
          <s-banner
            tone="warning"
            heading="Vault parser could not read the NMI response"
          >
            <s-paragraph>
              NMI returned {debug.xmlLength} bytes but the parser found no
              entries. This usually means the response uses a different
              wrapper element than expected.
            </s-paragraph>
            <s-paragraph tone="subdued">
              Check the server console for the `[NMI query ←]` log entry to
              see the raw XML, then adjust the wrapper detection in
              `app/services/nmi/nmi.utils.js`.
            </s-paragraph>
          </s-banner>
        )}

        {rows.length === 0 && !error ? (
          <s-box padding="large-500">
            <s-stack
              direction="block"
              gap="base"
              alignItems="center"
              justifyContent="center"
            >
              <s-text>{q ? "🔍" : "📭"}</s-text>
              <s-heading>{q ? "No matches" : "No vault entries"}</s-heading>
              <s-paragraph tone="subdued">
                {q
                  ? `No NMI customer vault entries match "${q}".`
                  : "NMI returned no customer vault entries."}
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={tableLoading}>
            <s-table-header-row>
              <s-table-header>Vault ID</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Payment method</s-table-header>
              <s-table-header>Card / ACH detail</s-table-header>
              <s-table-header>Created</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((c) => {
                const name =
                  [c.firstName, c.lastName].filter(Boolean).join(" ") ||
                  c.email ||
                  `Vault ${c.id}`;
                return (
                  <s-table-row key={c.id}>
                    <s-table-cell>#{c.id}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="block" gap="none">
                        <s-text>{name}</s-text>
                        {c.company && (
                          <s-text tone="subdued">{c.company}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{c.email || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          c.methodType === "card"
                            ? "info"
                            : c.methodType === "ach"
                              ? "warning"
                              : "default"
                        }
                      >
                        {c.methodLabel}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{c.methodDetail || "—"}</s-table-cell>
                    <s-table-cell>
                      {c.createdAt
                        ? new Date(c.createdAt).toLocaleDateString()
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={c.status === "Active" ? "success" : "default"}
                      >
                        {c.status}
                      </s-badge>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}

        {total > 0 && (
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-text tone="subdued">
              Showing {firstShown}–{lastShown} of {total}
            </s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-button
                variant="tertiary"
                disabled={page <= 1}
                onClick={() => updateParams({ page: page - 1 })}
                icon="arrow-left"
              >
                Previous
              </s-button>
              <s-text tone="subdued">
                Page {page} of {totalPages}
              </s-text>
              <s-button
                variant="tertiary"
                disabled={page >= totalPages}
                onClick={() => updateParams({ page: page + 1 })}
              >
                Next
              </s-button>
            </s-stack>
          </s-stack>
        )}

        {/* Always-visible diagnostic footer. Helps debug parser-vs-NMI
            mismatches (e.g. "I have 6 in the NMI admin but only N show
            here"). The raw response IS the source-of-truth: if the
            wrapper shape changes in a future NMI gateway version, we
            can update the parser in nmi.utils.js without guessing.
            Polaris-only (no inline styles) per the project rule. */}
        {debug && (
          <s-box
            padding="base"
            border="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="tight">
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-text tone="subdued">
                  Parser stats — {total} entr{total === 1 ? "y" : "ies"} from
                  NMI response ({debug.xmlLength} bytes)
                  {debug.errorMessage ? ` · error: ${debug.errorMessage}` : ""}
                </s-text>
                {debug.xmlPreview && (
                  <s-button
                    variant="tertiary"
                    onClick={() => setShowDebug((v) => !v)}
                  >
                    {showDebug ? "Hide raw response" : "Show raw NMI response"}
                  </s-button>
                )}
              </s-stack>
              {showDebug && debug.xmlPreview && (
                <s-box
                  padding="base"
                  border="base"
                  borderRadius="base"
                  background="default"
                >
                  {/* Plain <pre> without inline styles. Browser default
                      monospace + whitespace preservation is enough for
                      a debug surface; horizontal scroll comes from the
                      enclosing s-box. */}
                  <pre>{debug.xmlPreview}</pre>
                </s-box>
              )}
            </s-stack>
          </s-box>
        )}
        </s-stack>
      </s-section>
    </>
  );
}
