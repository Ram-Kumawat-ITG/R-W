import { Outlet, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPractitionerProfile,
  createPractitionerCode,
  updatePractitionerCode,
  deletePractitionerCode,
  setPrimaryPractitionerCode,
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
//   - This file also owns the `action` handler for referral-code CRUD
//     used by the Details tab — co-located here so a single form
//     submission can dispatch to any of the create / update / delete /
//     set-primary code operations via an `_action` field.
//
// The action HANDLER lives on the layout (not the tab) so:
//   1. Forms submitted from the Details tab don't need their own
//      route action (less duplication).
//   2. After a mutation, React Router auto-revalidates the layout's
//      loader AND the active child loader — the Details tab sees the
//      fresh code list without manual fetcher orchestration.
//   3. Future tabs (e.g. Settings) can reuse the same action endpoint
//      via fetcher.submit({ ...body }, { action: "/app/cdo-program/
//      customers/:id" }).

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const profile = await getPractitionerProfile(params.id);
  if (!profile) {
    throw new Response("Practitioner not found", { status: 404 });
  }
  return { profile };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";

  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();

  try {
    switch (op) {
      case "create-code": {
        const created = await createPractitionerCode({
          practitionerId: params.id,
          code: formData.get("code"),
          discountPercent: parseFractionField(formData.get("discountPercent")),
          commissionRate: parseFractionField(formData.get("commissionRate")),
          isPrimary: formData.get("isPrimary") === "true",
          note: formData.get("note"),
          actor,
        });
        return {
          status: "success",
          op,
          message: `Code ${created.code} created`,
        };
      }
      case "update-code": {
        const updates = {
          practitionerId: params.id,
          codeId: formData.get("codeId"),
          actor,
        };
        // Only forward fields the form actually carried so we don't
        // accidentally null a field the admin didn't touch.
        if (formData.has("code")) updates.code = formData.get("code");
        if (formData.has("discountPercent"))
          updates.discountPercent = parseFractionField(formData.get("discountPercent"));
        if (formData.has("commissionRate"))
          updates.commissionRate = parseFractionField(formData.get("commissionRate"));
        if (formData.has("status")) updates.status = formData.get("status");
        if (formData.has("note")) updates.note = formData.get("note");
        const updated = await updatePractitionerCode(updates);
        return {
          status: "success",
          op,
          message: `Code ${updated.code} updated`,
        };
      }
      case "delete-code": {
        await deletePractitionerCode({
          practitionerId: params.id,
          codeId: formData.get("codeId"),
        });
        return {
          status: "success",
          op,
          message: "Referral code deleted",
        };
      }
      case "set-primary-code": {
        const primary = await setPrimaryPractitionerCode({
          practitionerId: params.id,
          codeId: formData.get("codeId"),
          actor,
        });
        return {
          status: "success",
          op,
          message: `Primary code set to ${primary.code}`,
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

// The form fields surface percentage VALUES (e.g. "10" for 10%).
// `cdo_practitioner_codes` stores fractions (0.10). Convert here so
// service-layer normalisers only deal with one representation.
function parseFractionField(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Heuristic: values > 1 are interpreted as percentages, ≤ 1 as
  // pre-converted fractions. Keeps the API forgiving — admins typing
  // "0.1" or "10" both land at 0.10.
  return n > 1 ? n / 100 : n;
}

export default function CdoCustomerDetailLayout() {
  const { profile } = useLoaderData();
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
                  {profile.businessName && (
                    <s-text tone="subdued">· {profile.businessName}</s-text>
                  )}
                  {profile.customerId && (
                    <s-text tone="subdued">· ID {profile.customerId}</s-text>
                  )}
                </s-stack>
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
