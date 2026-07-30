import {
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { getProductSalesAnalytics } from "../services/qbo/qbo.service";
import { formatAmount, fmtDueDate } from "../utils/format.utils";
import { AdvancedFilters } from "../components/admin-ui";

// QBO Products analytics tab — "which product sold most" + revenue /
// quantity / margin per product, sourced live from QuickBooks' built-in
// "Sales by Product/Service" (ItemSales) report.
//
// This is only meaningful because invoice lines now reference per-variant
// QBO Items (qbo.service.resolveInvoiceItemId) — before that change every
// line hit the single default Item, so the report had one lumped row.
//
// The report reflects only invoices CREATED AFTER that change (QBO invoice
// lines aren't re-keyed retroactively) — a banner notes this. Data is
// per-variant (QBO has no variant grouping); rolling up by product/vendor
// would need QBO Item Categories, which aren't implemented yet.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const SORT_OPTIONS = [
  { value: "amount", label: "Revenue (high → low)" },
  { value: "quantity", label: "Quantity sold (high → low)" },
];
const GROUP_OPTIONS = [
  { value: "variant", label: "Variant (each QBO item)" },
  { value: "product", label: "Product (roll up variants)" },
  { value: "vendor", label: "Vendor" },
];
const FILTER_DEFAULTS = { sort: "amount", group: "variant" };
const FILTER_FIELDS = [
  { key: "dateFrom", label: "From date", type: "date" },
  { key: "dateTo", label: "To date", type: "date" },
  { key: "group", label: "Group by", type: "select", options: GROUP_OPTIONS },
  { key: "sort", label: "Sort by", type: "select", options: SORT_OPTIONS },
];

// Cap the rendered table so a very wide window can't produce an unwieldy
// page. Summaries below are still computed over ALL returned rows.
const MAX_ROWS = 250;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);

  const now = new Date();
  // Default window: trailing 90 days, so "top sellers" has meaningful data
  // out of the box. Both bounds are overridable via the filter card.
  const past = new Date(now);
  past.setDate(past.getDate() - 90);
  const defaultStart = ymd(past);
  const defaultEnd = ymd(now);

  const rawFrom = (url.searchParams.get("dateFrom") || "").trim();
  const rawTo = (url.searchParams.get("dateTo") || "").trim();
  // `startDate`/`endDate` are the RESOLVED window used for the QBO query + the
  // banner (default = trailing 90 days when unset). `dateFrom`/`dateTo` carry
  // the RAW url values (empty when unset) — those drive the filter form so the
  // default window is NOT shown as an "applied" filter chip and Reset works.
  const startDate = YMD_RE.test(rawFrom) ? rawFrom : defaultStart;
  const endDate = YMD_RE.test(rawTo) ? rawTo : defaultEnd;
  const sort = url.searchParams.get("sort") === "quantity" ? "quantity" : "amount";
  const rawGroup = url.searchParams.get("group");
  const group =
    rawGroup === "product" || rawGroup === "vendor" ? rawGroup : "variant";

  const commonState = { dateFrom: rawFrom, dateTo: rawTo, startDate, endDate, sort, group };

  try {
    const { rows, hasMargin, currency, groupBy } = await getProductSalesAnalytics({
      startDate,
      endDate,
      groupBy: group,
    });

    // Summaries over the full result set (before the display cap).
    const totalRevenue = Number(
      rows.reduce((s, r) => s + (r.amount || 0), 0).toFixed(2),
    );
    const totalUnits = rows.reduce((s, r) => s + (r.quantity || 0), 0);
    const productCount = rows.length;

    const sorted = [...rows].sort((a, b) => {
      const key = sort === "quantity" ? "quantity" : "amount";
      return (b[key] || 0) - (a[key] || 0);
    });

    // Attach revenue share + rank for the table.
    const ranked = sorted.slice(0, MAX_ROWS).map((r, i) => ({
      ...r,
      rank: i + 1,
      share:
        totalRevenue > 0 ? Number(((r.amount || 0) / totalRevenue) * 100) : 0,
    }));

    return {
      ...commonState,
      groupBy,
      rows: ranked,
      hasMargin,
      currency,
      totalRevenue,
      totalUnits,
      productCount,
      truncated: rows.length > MAX_ROWS,
      topSeller: sorted[0]
        ? { name: sorted[0].itemName, amount: sorted[0].amount, quantity: sorted[0].quantity }
        : null,
      error: null,
    };
  } catch (e) {
    console.error("[qbo/products] loader failed:", e?.message || e);
    return {
      ...commonState,
      groupBy: group,
      rows: [],
      hasMargin: false,
      currency: "USD",
      totalRevenue: 0,
      totalUnits: 0,
      productCount: 0,
      truncated: false,
      topSeller: null,
      error: e?.message || "Failed to load QBO product sales",
    };
  }
};

function fmtQty(n) {
  if (n === null || n === undefined) return "—";
  // Quantities can be fractional in QBO (e.g. weight-based items).
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export default function QboProducts() {
  const {
    rows,
    hasMargin,
    currency,
    totalRevenue,
    totalUnits,
    productCount,
    truncated,
    topSeller,
    dateFrom,
    dateTo,
    startDate,
    endDate,
    sort,
    group,
    groupBy,
    error,
  } = useLoaderData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const refreshing = revalidator.state !== "idle";
  const tableLoading = navigation.state === "loading" || refreshing;

  // Group-aware labels. `groupBy` is the EFFECTIVE grouping the loader used
  // (it falls back to 'variant' when there are no rows), matching what the
  // returned rows actually represent.
  const isVendor = groupBy === "vendor";
  const isRolled = groupBy === "vendor" || groupBy === "product";
  const nameHeader = isVendor ? "Vendor" : "Product";
  const countLabel = isVendor
    ? "Vendors"
    : groupBy === "product"
      ? "Products"
      : "Products (variants)";

  return (
    <>
      <AdvancedFilters
        fields={FILTER_FIELDS}
        values={{ dateFrom, dateTo, sort, group }}
        defaults={FILTER_DEFAULTS}
        onRefresh={() => revalidator.revalidate()}
        refreshing={refreshing}
        applying={tableLoading}
      />

      <s-section>
        <s-stack direction="block" gap="base">
          <s-banner tone="info" heading="How this is measured">
            <s-paragraph>
              Product sales come from the QuickBooks Sales by Product/Service
              report for {fmtDueDate(startDate)} – {fmtDueDate(endDate)}. Only
              invoices whose lines reference a QuickBooks product are counted —
              i.e. invoices created after product references were enabled.
              {isRolled
                ? ` Rolled up by ${isVendor ? "vendor" : "product"} from the Shopify↔QBO product mapping; items with no mapping appear as ${isVendor ? '"(No vendor)"' : "their own row"}.`
                : " Figures are per variant (each Shopify variant is its own QuickBooks item)."}
            </s-paragraph>
          </s-banner>

          {error && (
            <s-banner tone="critical" heading="Could not load product sales">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}

          {/* Summary tiles */}
          <s-grid
            gridTemplateColumns="repeat(auto-fill, minmax(200px, 1fr))"
            gap="base"
          >
            <s-box padding="base" borderWidth="small" borderRadius="base">
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Total revenue</s-text>
                <s-heading>{formatAmount(totalRevenue, currency)}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="small" borderRadius="base">
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Units sold</s-text>
                <s-heading>{fmtQty(totalUnits)}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="small" borderRadius="base">
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">{countLabel}</s-text>
                <s-heading>{productCount}</s-heading>
              </s-stack>
            </s-box>
            <s-box padding="base" borderWidth="small" borderRadius="base">
              <s-stack direction="block" gap="none">
                <s-text tone="subdued">Top seller</s-text>
                <s-text>
                  <strong>{topSeller ? topSeller.name : "—"}</strong>
                </s-text>
                {topSeller && (
                  <s-text tone="subdued">
                    {formatAmount(topSeller.amount || 0, currency)} ·{" "}
                    {fmtQty(topSeller.quantity)} units
                  </s-text>
                )}
              </s-stack>
            </s-box>
          </s-grid>

          {truncated && (
            <s-banner tone="warning">
              <s-paragraph>
                Showing the top {rows.length} by {sort === "quantity" ? "quantity" : "revenue"}.
                Narrow the date range to see the full list.
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
                <s-text>📦</s-text>
                <s-heading>No product sales</s-heading>
                <s-paragraph tone="subdued">
                  QuickBooks reported no product sales for this date range.
                </s-paragraph>
              </s-stack>
            </s-box>
          ) : (
            <s-table loading={tableLoading}>
              <s-table-header-row>
                <s-table-header>#</s-table-header>
                <s-table-header>{nameHeader}</s-table-header>
                {isRolled && <s-table-header>Variants</s-table-header>}
                <s-table-header>Units sold</s-table-header>
                <s-table-header>Inventory in hand</s-table-header>
                <s-table-header>Revenue</s-table-header>
                <s-table-header>% of revenue</s-table-header>
                <s-table-header>Avg price</s-table-header>
                {hasMargin && <s-table-header>COGS</s-table-header>}
                {hasMargin && <s-table-header>Gross margin</s-table-header>}
              </s-table-header-row>
              <s-table-body>
                {rows.map((r) => (
                  <s-table-row key={r.itemId || `${r.rank}-${r.itemName}`}>
                    <s-table-cell>{r.rank}</s-table-cell>
                    <s-table-cell>{r.itemName}</s-table-cell>
                    {isRolled && (
                      <s-table-cell>{r.variantCount ?? "—"}</s-table-cell>
                    )}
                    <s-table-cell>{fmtQty(r.quantity)}</s-table-cell>
                    <s-table-cell>{fmtQty(r.qtyOnHand)}</s-table-cell>
                    <s-table-cell>
                      {r.amount != null ? formatAmount(r.amount, currency) : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {totalRevenue > 0 ? `${r.share.toFixed(1)}%` : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      {r.avgPrice != null ? formatAmount(r.avgPrice, currency) : "—"}
                    </s-table-cell>
                    {hasMargin && (
                      <s-table-cell>
                        {r.cogs != null ? formatAmount(r.cogs, currency) : "—"}
                      </s-table-cell>
                    )}
                    {hasMargin && (
                      <s-table-cell>
                        {r.grossMargin != null
                          ? formatAmount(r.grossMargin, currency)
                          : "—"}
                      </s-table-cell>
                    )}
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </>
  );
}
