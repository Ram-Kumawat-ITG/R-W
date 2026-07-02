import { Outlet, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  getPractitionerHold,
  createPractitionerCode,
  setPractitionerCodeStatus,
} from "../services/cdo/cdo.service";
import CustomerTabs from "../components/cdo/CustomerTabs";
import StatusBadge from "../components/cdo/StatusBadge";
import { formatDateTime } from "../utils/format";

// CDO Practitioner detail page — `/app/cdo-program/customers/:id/*`.
//
// Layout structure:
//   - This file owns the page header (name, email, status, ID) +
//     the sub-tab bar.
//   - Child routes (_index, commissions, downline, network, sales,
//     payments, transactions, settings) render into the <Outlet />.
//   - This file owns the `action` IMPLEMENTATION for referral-code
//     pause/resume used by the Details tab — co-located here so the form
//     submission can dispatch the `set-code-status` operation via an
//     `_action` field. (Code create / edit / delete / set-primary were
//     removed from this page — codes are created by practitioners in the
//     Practitioner Portal; this page is pause/resume oversight only.)
//
// NOTE on routing: React Router runs a submission's action on the LEAF
// matched route. For the URL `/app/cdo-program/customers/:id` the leaf is
// the `_index` route, NOT this layout — so the Details tab re-exports this
// `action` from `app.cdo-program.customers.$id._index.jsx` to serve its
// `fetcher.submit({ ...body }, { method: "POST" })` calls. We keep the
// implementation here as the single source of truth:
//   1. After a mutation, React Router auto-revalidates the active child
//      loader AND this layout's loader — the Details tab sees the fresh
//      code list without manual fetcher orchestration.
//   2. Future tabs that need code CRUD can re-export this same `action`
//      from their own route module the same way the `_index` tab does.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const profile = await getPractitionerProfile(params.id);
  if (!profile) {
    throw new Response("Practitioner not found", { status: 404 });
  }
  const hold = await getPractitionerHold(params.id);
  return { profile, hold };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();

  try {
    switch (op) {
      // Create a referral code (admin). Discount % is OPTIONAL (blank → 0% /
      // attribution-only; a discount also creates the backing Shopify discount
      // on this retail store). NO commission field — commission is configured
      // per product vendor (Settings → Commission Configuration), so codes are
      // always created without a practitioner-level commission rate (inherits
      // null; vendor config drives the amount).
      case "create-code": {
        const created = await createPractitionerCode({
          practitionerId: params.id,
          code: formData.get("code"),
          discountPercent: parseFractionField(formData.get("discountPercent")),
          actor,
          shop: session?.shop,
        });
        return {
          status: "success",
          op,
          message: `Code ${created.code} created`,
        };
      }
      // Pause / resume — flips the DB status AND deactivates/reactivates the
      // backing Shopify discount (cdo.service delegates to cdo.discount.service),
      // so a paused code genuinely stops applying on the storefront. Referral
      // tracking + earned commissions are untouched (immutable history).
      case "set-code-status": {
        const status = String(formData.get("status") || "").trim();
        const updated = await setPractitionerCodeStatus({
          practitionerId: params.id,
          codeId: formData.get("codeId"),
          status,
          actor,
          // The backing Shopify discount lives on THIS (retail) store — pass
          // the logged-in shop so the toggle targets the right Admin API.
          shop: session?.shop,
        });
        return {
          status: "success",
          op,
          message:
            status === "paused"
              ? `Code ${updated.code} paused`
              : `Code ${updated.code} resumed`,
        };
      }
      default:
        return {
          status: "error",
          op,
          message: `Unknown action: ${op}`,
        };
    }
  } catch (e) {
    console.error(`[cdo-program/customers/${params.id}] action ${op} failed:`, e?.message || e);
    return {
      status: "error",
      op,
      message: e?.message || "Action failed",
    };
  }
};

// The Discount % / Commission % form fields surface percentage VALUES (e.g.
// "20" for 20%); `cdo_practitioner_codes` stores fractions (0.20). Convert
// here so the service-layer normalisers only deal with one representation.
// Blank → null (optional: blank discount → 0%, blank commission → inherit).
function parseFractionField(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Heuristic: values > 1 are interpreted as percentages, ≤ 1 as
  // pre-converted fractions. Keeps the API forgiving — admins typing
  // "0.2" or "20" both land at 0.20.
  return n > 1 ? n / 100 : n;
}

export default function CdoCustomerDetailLayout() {
  const { profile, hold } = useLoaderData();
  const navigate = useNavigate();

  const initials =
    `${profile.firstName?.[0] || ""}${profile.lastName?.[0] || ""}`.toUpperCase() ||
    profile.email?.[0]?.toUpperCase() ||
    "?";

  // Show just the numeric portion of the Shopify GID (strip gid://shopify/Customer/)
  const shortId = profile.customerId ? profile.customerId.split("/").pop() : null;

  return (
    <>
      <s-box paddingBlockEnd="small-200">
        <s-button
          variant="tertiary"
          icon="arrow-left"
          onClick={() => navigate("/app/cdo-program/customers")}
        >
          Back to CDO Customers
        </s-button>
      </s-box>

      {/* Practitioner hero card */}
      <div style={{
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        overflow: "hidden",
        marginBottom: "20px",
      }}>
        {/* Teal accent strip */}
        <div style={{ height: "4px", background: "linear-gradient(90deg, #00a47c 0%, #007c59 100%)" }} />

        <div style={{ padding: "20px 24px", display: "flex", alignItems: "flex-start", gap: "16px" }}>
          <s-avatar initials={initials} size="large" />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Name + status badges */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "20px", fontWeight: "600", color: "#303030", lineHeight: "1.3" }}>
                {profile.name || profile.email || "Practitioner"}
              </span>
              <StatusBadge status={profile.status} />
              <s-badge tone={hold?.paused ? "warning" : "success"}>
                {hold?.paused ? "Payouts paused" : "Payouts active"}
              </s-badge>
            </div>

            {/* Email */}
            {profile.email && (
              <div style={{ fontSize: "14px", color: "#6d7175", marginBottom: "10px" }}>
                {profile.email}
              </div>
            )}

            {/* Compact metadata row */}
            <div style={{ display: "flex", flexWrap: "wrap", rowGap: "4px", columnGap: "20px", fontSize: "13px", color: "#8c9196" }}>
              {profile.businessName && <span>{profile.businessName}</span>}
              {shortId && <span>Customer #{shortId}</span>}
              {profile.submittedAt && (
                <span>Registered {formatDateTime(profile.submittedAt)}</span>
              )}
              {profile.country && <span>From {profile.country}</span>}
            </div>
          </div>
        </div>

        {/* Paused payouts warning strip */}
        {hold?.paused && (
          <div style={{
            background: "#fff3cd",
            borderTop: "1px solid #f5e197",
            padding: "10px 24px",
            fontSize: "13px",
            color: "#856404",
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
          }}>
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span>
              Commission payouts paused
              {hold.pausedBy ? ` by ${hold.pausedBy}` : ""}
              {hold.pausedAt ? ` on ${formatDateTime(hold.pausedAt)}` : ""}
              {hold.note ? ` — ${hold.note}` : ""}.{" "}
              Commissions still accrue; manage on the Settings tab.
            </span>
          </div>
        )}
      </div>

      <CustomerTabs practitionerId={profile.id} />
      <Outlet />
    </>
  );
}
