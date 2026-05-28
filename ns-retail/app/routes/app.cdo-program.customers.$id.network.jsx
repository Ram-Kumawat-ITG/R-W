import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPractitionerKpis,
  listPractitionerReferrals,
} from "../services/cdo/cdo.service";
import MetricCard from "../components/cdo/MetricCard";
import { formatNumber, formatPercent } from "../utils/format";

// Network tab — the practitioner's referral funnel + downline depth.
// First iteration is a summary card backed by the referral counts that
// already drive the Details KPIs. The full multi-level "tree" view
// (referrer → referred → their referred ...) lives in cdo_referrals
// and would require a graph traversal — keeping that for follow-up.

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const [kpis, referrals] = await Promise.all([
    getPractitionerKpis(params.id),
    listPractitionerReferrals(params.id),
  ]);
  return { kpis, referrals };
};

export default function CdoCustomerNetwork() {
  const { kpis, referrals } = useLoaderData();
  const pending = referrals.filter((r) => r.status === "pending").length;
  const converted = referrals.filter((r) => r.status === "converted").length;
  const expired = referrals.filter((r) => r.status === "expired").length;

  return (
    <s-section heading="Network performance">
      <s-stack direction="block" gap="base">
        <s-paragraph tone="subdued">
          Funnel summary across this practitioner&apos;s direct referrals.
          Multi-level downline (referrer → referred → their referred …) is on
          the roadmap — `cdo_referrals` already records the referrer link, so
          the extension is a graph traversal away.
        </s-paragraph>
        <s-grid gap="base" gridTemplateColumns="repeat(4, minmax(0, 1fr))">
          <MetricCard
            label="Total referrals"
            value={formatNumber(kpis.totalReferrals)}
          />
          <MetricCard
            label="Converted"
            value={formatNumber(converted)}
            tone="success"
          />
          <MetricCard
            label="Pending"
            value={formatNumber(pending)}
          />
          <MetricCard
            label="Expired"
            value={formatNumber(expired)}
          />
          <MetricCard
            label="Conversion rate"
            value={formatPercent(kpis.conversionRate)}
            sublabel="Converted / total"
          />
        </s-grid>
      </s-stack>
    </s-section>
  );
}
