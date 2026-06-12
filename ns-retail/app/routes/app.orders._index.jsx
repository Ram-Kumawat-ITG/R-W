/* eslint-disable react/prop-types */
import { useRef, useState } from "react";
import { useLoaderData, useNavigate, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { listCdoOrders } from "../services/cdo/cdo.service";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatCurrency, formatDate } from "../utils/format";

const PAGE_SIZE = 25;

const FILTER_KEYS = [
  "orderNumber",
  "customer",
  "practitioner",
  "referralCode",
  "status",
  "financialStatus",
  "commissionStatus",
  "dateFrom",
  "dateTo",
];

// Project the active (URL) filters into a full draft shape (every key present,
// defaulting to "").
function pickFilters(filters) {
  const out = {};
  for (const k of FILTER_KEYS) out[k] = filters?.[k] || "";
  return out;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const sp = url.searchParams;

  const filters = {};
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) filters[k] = v;
  }
  const page = Number(sp.get("page")) || 1;
  const sort = sp.get("sort") || "placedAt";
  const dir = sp.get("dir") || "desc";

  const result = await listCdoOrders({ page, pageSize: PAGE_SIZE, sort, dir, filters });
  return { result, filters, sort, dir };
};

export default function OrdersList() {
  const { result, filters, sort, dir } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  const EMPTY_DRAFT = {
    orderNumber: "", customer: "", practitioner: "", referralCode: "",
    status: "", financialStatus: "", commissionStatus: "", dateFrom: "", dateTo: "",
  };

  // Local, editable copy of the active filters. A ref MIRRORS it (updated
  // synchronously in the change handler) so "Apply filters" always reads the
  // freshest values — even when a control commits its value on `blur` (which
  // fires just before the button's click) rather than per keystroke. Polaris
  // s-* controls differ in whether they emit `input` or `change`, so we bind
  // BOTH and read from the ref instead of the (possibly-stale) state closure.
  const [draft, setDraft] = useState(() => ({ ...EMPTY_DRAFT, ...pickFilters(filters) }));
  const draftRef = useRef(draft);

  const set = (k) => (e) => {
    const v = e?.currentTarget?.value ?? "";
    draftRef.current = { ...draftRef.current, [k]: v };
    setDraft((d) => ({ ...d, [k]: v }));
  };
  // Spread onto every control so the value is captured no matter which event
  // the component emits.
  const bind = (k) => ({ value: draft[k], onInput: set(k), onChange: set(k) });

  const goto = (next) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
    }
    navigate(`?${params.toString()}`);
  };

  const applyFilters = () => goto({ ...draftRef.current, sort, dir, page: "1" });

  const resetFilters = () => {
    draftRef.current = { ...EMPTY_DRAFT };
    setDraft({ ...EMPTY_DRAFT });
    navigate("?");
  };

  const setSort = (field) => {
    const nextDir = sort === field && dir === "desc" ? "asc" : "desc";
    goto({ ...filters, sort: field, dir: nextDir, page: "1" });
  };

  const setPage = (p) => goto({ ...filters, sort, dir, page: String(p) });

  const sortArrow = (field) => (sort === field ? (dir === "asc" ? " ▲" : " ▼") : "");

  const { rows, total, page, pageCount } = result;

  return (
    <s-stack direction="block" gap="base">
      <s-section heading="Filters">
        <s-stack direction="block" gap="base">
          <s-grid gap="base" gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))">
            <s-text-field label="Order number" {...bind("orderNumber")} placeholder="#1001" />
            <s-text-field label="Customer" {...bind("customer")} placeholder="Name or email" />
            <s-text-field label="Practitioner" {...bind("practitioner")} placeholder="Name or email" />
            <s-text-field label="Referral code" {...bind("referralCode")} />
            <s-select label="Order status" {...bind("status")}>
              <s-option value="">Any</s-option>
              <s-option value="pending">Pending</s-option>
              <s-option value="approved">Approved</s-option>
              <s-option value="paid">Paid</s-option>
              <s-option value="cancelled">Cancelled</s-option>
            </s-select>
            <s-select label="Payment status" {...bind("financialStatus")}>
              <s-option value="">Any</s-option>
              <s-option value="paid">Paid</s-option>
              <s-option value="pending">Pending</s-option>
              <s-option value="partially_paid">Partially paid</s-option>
              <s-option value="refunded">Refunded</s-option>
              <s-option value="partially_refunded">Partially refunded</s-option>
              <s-option value="voided">Voided</s-option>
            </s-select>
            <s-select label="Commission status" {...bind("commissionStatus")}>
              <s-option value="">Any</s-option>
              <s-option value="attributed">Attributed</s-option>
              <s-option value="unattributed">Unattributed</s-option>
            </s-select>
            <s-date-field label="From date" {...bind("dateFrom")} />
            <s-date-field label="To date" {...bind("dateTo")} />
          </s-grid>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={applyFilters} {...(loading ? { loading: true } : {})}>
              Apply filters
            </s-button>
            <s-button variant="tertiary" onClick={resetFilters}>Reset</s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section padding="none">
        <s-box padding="base">
          <s-text tone="subdued">
            {total} order{total === 1 ? "" : "s"} · page {page} of {pageCount}
          </s-text>
        </s-box>
        {rows.length === 0 ? (
          <s-box padding="large-500">
            <s-stack direction="block" gap="base" alignItems="center" justifyContent="center">
              <s-heading>No orders found</s-heading>
              <s-paragraph tone="subdued">No cdo_orders match the current filters.</s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table loading={loading}>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Practitioner</s-table-header>
              <s-table-header>Referral</s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("amount")}>Amount{sortArrow("amount")}</s-clickable>
              </s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("commissionAmount")}>Commission{sortArrow("commissionAmount")}</s-clickable>
              </s-table-header>
              <s-table-header>Order status</s-table-header>
              <s-table-header>Payment</s-table-header>
              <s-table-header>
                <s-clickable onClick={() => setSort("placedAt")}>Date{sortArrow("placedAt")}</s-clickable>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((o) => (
                <s-table-row key={o.id} onClick={() => navigate(`/app/orders/${o.id}`)}>
                  <s-table-cell>
                    <s-link href={`/app/orders/${o.id}`}>{o.orderName}</s-link>
                  </s-table-cell>
                  <s-table-cell>{o.customerName}</s-table-cell>
                  <s-table-cell>{o.practitionerName}</s-table-cell>
                  <s-table-cell>{o.referralCode}</s-table-cell>
                  <s-table-cell>{formatCurrency(o.amount, o.currency)}</s-table-cell>
                  <s-table-cell>{o.attributed ? formatCurrency(o.commissionAmount, o.currency) : "—"}</s-table-cell>
                  <s-table-cell><StatusBadge status={o.status} /></s-table-cell>
                  <s-table-cell>{o.financialStatus}</s-table-cell>
                  <s-table-cell>{formatDate(o.placedAt)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-box padding="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="end">
            <s-button variant="tertiary" icon="arrow-left" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </s-button>
            <s-text tone="subdued">Page {page} of {pageCount}</s-text>
            <s-button variant="tertiary" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
              Next
            </s-button>
          </s-stack>
        </s-box>
      </s-section>
    </s-stack>
  );
}
