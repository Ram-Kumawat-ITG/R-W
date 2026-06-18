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
      // Create a referral code (admin). Discount % + Commission % are OPTIONAL
      // (blank discount → 0% / attribution-only; blank commission → inherits the
      // program default). When a discount is set, the service also creates the
      // backing Shopify discount on this (retail) store.
      case "create-code": {
        const created = await createPractitionerCode({
          practitionerId: params.id,
          code: formData.get("code"),
          discountPercent: parseFractionField(formData.get("discountPercent")),
          commissionRate: parseFractionField(formData.get("commissionRate")),
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

  return (
    <>
      <s-box paddingBlockEnd="base">
        <s-button
          variant="tertiary"
          icon="arrow-left"
          onClick={() => navigate("/app/cdo-program/customers")}
        >
          Back to CDO Customers
        </s-button>
      </s-box>

      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-avatar initials={initials} size="large" />
              <s-stack direction="block" gap="none">
                <s-heading>
                  {profile.name || profile.email || "Practitioner"}
                </s-heading>
                {profile.email && (
                  <s-text tone="subdued">{profile.email}</s-text>
                )}
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <StatusBadge status={profile.status} />
                  <s-badge tone={hold?.paused ? "warning" : "success"}>
                    {hold?.paused ? "Payouts paused" : "Payouts active"}
                  </s-badge>
                  {profile.businessName && (
                    <s-text tone="subdued">· {profile.businessName}</s-text>
                  )}
                  {profile.customerId && (
                    <s-text tone="subdued">· ID {profile.customerId}</s-text>
                  )}
                </s-stack>
                {hold?.paused && (
                  <s-text tone="subdued">
                    Commission payouts paused
                    {hold.pausedBy ? ` by ${hold.pausedBy}` : ""}
                    {hold.pausedAt ? ` on ${formatDateTime(hold.pausedAt)}` : ""}
                    {hold.note ? ` — ${hold.note}` : ""}. Commissions still accrue; manage on the
                    Settings tab.
                  </s-text>
                )}
                {profile.submittedAt && (
                  <s-text tone="subdued">
                    Registered {formatDateTime(profile.submittedAt)}
                    {profile.country ? ` · From ${profile.country}` : ""}
                  </s-text>
                )}
              </s-stack>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      <s-box paddingBlockStart="base">
        <CustomerTabs practitionerId={profile.id} />
      </s-box>

      <Outlet />
    </>
  );
}
