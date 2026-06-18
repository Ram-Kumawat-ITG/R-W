/* eslint-disable react/prop-types */
// Commission Configuration — per-vendor commission rates.
//
// Lists every Shopify product vendor (merged with saved configs) and lets an
// admin set a commission % per vendor via a "Commission Setup" modal. Commission
// is VENDOR-DRIVEN: each order line earns lineRevenue × its vendor's rate, and a
// product whose vendor has no rate here earns 0%. Saving bumps the config
// version + writes an audit row; the version is snapshotted onto each order at
// ingest, so edits apply only to FUTURE orders.

import { forwardRef, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  fetchProductVendors,
  getVendorCommissions,
  setVendorCommission,
  removeVendorCommission,
  getCommissionConfigHistory,
} from "../services/cdo/cdo.service";
import { formatPercent, formatDateTime } from "../utils/format";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const [vendorList, saved, history] = await Promise.all([
    fetchProductVendors(admin),
    getVendorCommissions(),
    getCommissionConfigHistory({ limit: 25 }),
  ]);

  // Merge the live Shopify vendor list with saved configs (union), so a saved
  // vendor that no longer appears in Shopify still shows (flagged) for removal.
  const savedByKey = new Map(
    saved.vendors.map((v) => [v.vendor.trim().toLowerCase(), v]),
  );
  const seen = new Set();
  const vendors = [];
  for (const name of vendorList) {
    const key = name.trim().toLowerCase();
    const s = savedByKey.get(key);
    seen.add(key);
    vendors.push({
      vendor: name,
      commissionPercent: s ? s.commissionPercent : null,
      configured: Boolean(s),
      updatedAt: s?.updatedAt || null,
      updatedBy: s?.updatedBy || null,
      missingFromShopify: false,
    });
  }
  for (const s of saved.vendors) {
    const key = s.vendor.trim().toLowerCase();
    if (seen.has(key)) continue;
    vendors.push({
      vendor: s.vendor,
      commissionPercent: s.commissionPercent,
      configured: true,
      updatedAt: s.updatedAt || null,
      updatedBy: s.updatedBy || null,
      missingFromShopify: true,
    });
  }
  vendors.sort((a, b) => a.vendor.localeCompare(b.vendor));

  return { vendors, version: saved.version, history };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const actor =
    session?.onlineAccessInfo?.associated_user?.email || session?.shop || "admin";
  const formData = await request.formData();
  const op = String(formData.get("_action") || "").trim();

  try {
    if (op === "save-vendor-commission") {
      const vendor = String(formData.get("vendor") || "").trim();
      const raw = String(formData.get("commissionPercent") ?? "").trim();
      const pct = Number(raw);
      if (!vendor) throw new Error("Vendor is required");
      if (raw === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error("Commission percent must be a number between 0 and 100");
      }
      // UI sends a whole-number percent; the service stores a fraction.
      await setVendorCommission({
        vendor,
        commissionPercent: pct / 100,
        actor,
      });
      return { status: "success", op, message: `Saved ${vendor} commission (${pct}%)` };
    }

    if (op === "remove-vendor-commission") {
      const vendor = String(formData.get("vendor") || "").trim();
      await removeVendorCommission({ vendor, actor });
      return { status: "success", op, message: `Removed ${vendor} commission` };
    }

    return { status: "error", op, message: `Unknown action: ${op}` };
  } catch (e) {
    return { status: "error", op, message: e?.message || "Action failed" };
  }
};

// Render a vendor's configured rate, or a clear "0%" when unconfigured.
function rateLabel(v) {
  if (!v.configured) return "0% (not configured)";
  return formatPercent(v.commissionPercent);
}

function historyLabel(h) {
  if (h.action === "remove") {
    return `Removed (was ${formatPercent(h.previousPercent || 0)})`;
  }
  const from =
    h.previousPercent == null ? "unset" : formatPercent(h.previousPercent);
  return `${from} → ${formatPercent(h.newPercent || 0)}`;
}

export default function CdoCommissionConfig() {
  const { vendors, history } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const modalRef = useRef(null);
  const handledRef = useRef(null);
  const [editing, setEditing] = useState(null); // vendor row being configured

  const mutating = fetcher.state === "submitting" || fetcher.state === "loading";

  // Toast + close modal once per settled response.
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if (handledRef.current === fetcher.data) return;
    handledRef.current = fetcher.data;
    const d = fetcher.data;
    if (d.status === "success") {
      shopify?.toast?.show(d.message || "Saved");
      modalRef.current?.hideOverlay?.();
      setEditing(null);
    } else {
      shopify?.toast?.show(d.message || "Action failed", { isError: true });
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const onSetup = (row) => {
    setEditing(row);
    modalRef.current?.showOverlay?.();
  };

  const configuredCount = vendors.filter((v) => v.configured).length;

  return (
    <>
      <s-section heading={`Commission Configuration (${vendors.length} vendors)`}>
        <s-stack direction="block" gap="base">
          <s-banner tone="warning" heading="Vendors earn 0% until configured">
            <s-paragraph>
              Commission is calculated per product using the rate set for its
              vendor. A product whose vendor has no rate set here earns 0%
              commission. Changes apply only to future orders — existing orders
              and commissions keep the rate captured when they were placed.
            </s-paragraph>
          </s-banner>

          {vendors.length === 0 ? (
            <s-paragraph tone="subdued">
              No product vendors found on the store yet. Vendors appear here once
              products with a vendor exist in Shopify.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Vendor</s-table-header>
                <s-table-header>Commission</s-table-header>
                <s-table-header>Last updated</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {vendors.map((v) => (
                  <s-table-row key={v.vendor}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-text>{v.vendor}</s-text>
                        {v.missingFromShopify && (
                          <s-badge tone="neutral">Not in Shopify</s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {v.configured ? (
                        <s-badge tone="success">{rateLabel(v)}</s-badge>
                      ) : (
                        <s-text tone="subdued">{rateLabel(v)}</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {v.updatedAt ? formatDateTime(v.updatedAt) : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" onClick={() => onSetup(v)}>
                        Commission Setup
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          <s-text tone="subdued">
            {configuredCount} of {vendors.length} vendors configured.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Recent changes">
        {history.length === 0 ? (
          <s-paragraph tone="subdued">
            No commission configuration changes yet.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Vendor</s-table-header>
              <s-table-header>Change</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((h) => (
                <s-table-row key={h.id}>
                  <s-table-cell>{h.vendor}</s-table-cell>
                  <s-table-cell>{historyLabel(h)}</s-table-cell>
                  <s-table-cell>{h.changedBy}</s-table-cell>
                  <s-table-cell>
                    {h.changedAt ? formatDateTime(h.changedAt) : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <CommissionSetupModal
        ref={modalRef}
        vendor={editing}
        fetcher={fetcher}
        mutating={mutating}
        onClose={() => {
          modalRef.current?.hideOverlay?.();
          setEditing(null);
        }}
      />
    </>
  );
}

// eslint-disable-next-line react/display-name
const CommissionSetupModal = forwardRef(function CommissionSetupModal(
  { vendor, fetcher, mutating, onClose },
  ref,
) {
  const [percent, setPercent] = useState("");

  // Seed the field from the row each time a different vendor is opened. Stored
  // values are fractions; the field edits whole-number percent.
  useEffect(() => {
    if (!vendor) return;
    setPercent(
      vendor.commissionPercent != null
        ? String(Number((vendor.commissionPercent * 100).toFixed(2)))
        : "",
    );
  }, [vendor]);

  const save = () => {
    fetcher.submit(
      {
        _action: "save-vendor-commission",
        vendor: vendor?.vendor || "",
        commissionPercent: percent === "" ? "" : String(percent),
      },
      { method: "POST" },
    );
  };

  const remove = () => {
    fetcher.submit(
      { _action: "remove-vendor-commission", vendor: vendor?.vendor || "" },
      { method: "POST" },
    );
  };

  return (
    <s-modal
      ref={ref}
      id="cdo-commission-setup-modal"
      heading={vendor ? `Commission setup — ${vendor.vendor}` : "Commission setup"}
      accessibilityLabel="Configure vendor commission"
    >
      {vendor ? (
        <s-stack direction="block" gap="base">
          <s-paragraph tone="subdued">
            Set the commission percentage earned on products from{" "}
            <s-text type="strong">{vendor.vendor}</s-text>. Applies to future
            orders only.
          </s-paragraph>
          <s-text-field
            label="Commission %"
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={percent}
            onChange={(e) => setPercent(e.currentTarget.value)}
            details="Whole-number percent (e.g. 15 for 15%). 0 means no commission."
          />
        </s-stack>
      ) : null}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(mutating ? { loading: true } : {})}
      >
        Save
      </s-button>
      {vendor?.configured ? (
        <s-button slot="secondary-actions" tone="critical" onClick={remove}>
          Remove
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={onClose}>
        Cancel
      </s-button>
    </s-modal>
  );
});
