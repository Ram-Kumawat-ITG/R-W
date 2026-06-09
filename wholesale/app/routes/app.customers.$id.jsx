import { useEffect, useRef, useState } from "react";
import mongoose from "mongoose";
import { useLoaderData, useNavigate, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { buildShopifyNote } from "../services/shopify/shopify.utils";
import {
  CREDENTIAL_MAP,
  REFERRAL_MAP,
} from "../services/shopify/shopify.constants";
import { KV } from "../components/admin-ui";

// Human-readable labels for the W-9 federal tax classification enum.
// Mirrors the labels shown in the registration form (Step 4) so admins
// see the same wording the practitioner did.
const W9_CLASSIFICATION_LABELS = {
  individual: "Individual / sole proprietor or single-member LLC",
  c_corp: "C Corporation",
  s_corp: "S Corporation",
  partnership: "Partnership",
  trust_estate: "Trust / estate",
  llc: "Limited liability company (LLC)",
  other: "Other (specify)",
};

const W9_LLC_LABELS = {
  C: "C — C Corporation",
  S: "S — S Corporation",
  P: "P — Partnership",
};

// Mask a TIN (SSN or EIN) for display, showing only the last 4 digits.
function maskTin(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "•••••";
  return `•••-••-${digits.slice(-4)}`;
}

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);
  const { id } = params;
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new Response("Invalid id", { status: 400 });
  }
  await connectDB();
  const doc = await WholesaleApplication.findById(id).lean();
  if (!doc) throw new Response("Not found", { status: 404 });

  const application = { ...doc, _id: doc._id.toString() };
  const shopifyNote = buildShopifyNote(application);
  return { application, shopifyNote };
};

export default function CustomerDetail() {
  const { application: a, shopifyNote } = useLoaderData();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const [bannerError, setBannerError] = useState(null);
  const [expandedCredId, setExpandedCredId] = useState(null);
  const modalRef = useRef(null);

  // Payment-preference change control (realigns the customer's open invoices).
  const prefFetcher = useFetcher();
  const prefModalRef = useRef(null);
  const currentMethod = normalizeMethod(a.payment?.method);
  const [methodChoice, setMethodChoice] = useState(currentMethod);
  const applyingPref =
    prefFetcher.state === "submitting" || prefFetcher.state === "loading";
  const handledPrefRef = useRef(null);
  const methodHistory = Array.isArray(a.paymentMethodHistory)
    ? [...a.paymentMethodHistory].reverse()
    : [];

  const fullName =
    `${a.firstName || ""} ${a.lastName || ""}`.trim() || "(no name)";
  const declining =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const loadedToastShown = useRef(false);
  // Track which response we've handled so React-Router's automatic
  // post-action revalidation doesn't re-trigger toast / navigate / banner
  // on every subsequent render.
  const handledDeclineRef = useRef(null);

  // One-time toast confirming data fetched + showing current approval status.
  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    if (a.shopifyCreateFailed) {
      shopify?.toast?.show(`Loaded ${fullName} — Shopify sync failed`, {
        isError: true,
      });
    } else {
      shopify?.toast?.show(`Loaded ${fullName} — Approved`);
    }
  }, [a.shopifyCreateFailed, fullName, shopify]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.state !== "idle") return;
    if (handledDeclineRef.current === fetcher.data) return;
    handledDeclineRef.current = fetcher.data;

    if (fetcher.data.status === "success") {
      shopify?.toast?.show("Customer blocked.");
      navigate("/app/customers");
    } else if (fetcher.data.status === "error") {
      setBannerError(
        fetcher.data.result?.detail ||
          fetcher.data.message ||
          "Block failed. Please retry.",
      );
    }
  }, [fetcher.data, fetcher.state, navigate, shopify]);

  const onConfirmBlock = () => {
    setBannerError(null);
    closeModal();
    fetcher.submit(null, {
      method: "POST",
      action: `/api/admin/customers/${a._id}/block`,
    });
    navigate("/app/customers");
  };
  const openModal = () => modalRef.current?.showOverlay?.();
  const closeModal = () => modalRef.current?.hideOverlay?.();

  // Surface the payment-preference result (toast on success, banner on error).
  useEffect(() => {
    if (!prefFetcher.data) return;
    if (prefFetcher.state !== "idle") return;
    if (handledPrefRef.current === prefFetcher.data) return;
    handledPrefRef.current = prefFetcher.data;
    const d = prefFetcher.data;
    if (d.status === "success") {
      const r = d.result || {};
      shopify?.toast?.show(
        `Payment method set to ${r.newMethod || methodChoice} — ` +
          `${r.updated || 0} invoice(s) updated` +
          (r.failed ? `, ${r.failed} failed` : ""),
      );
    } else {
      setBannerError(
        d.result?.detail || d.message || "Couldn't update the payment method.",
      );
    }
  }, [prefFetcher.data, prefFetcher.state, shopify, methodChoice]);

  const openPrefModal = () => prefModalRef.current?.showOverlay?.();
  const closePrefModal = () => prefModalRef.current?.hideOverlay?.();
  const onConfirmApplyMethod = () => {
    setBannerError(null);
    closePrefModal();
    prefFetcher.submit(
      { method: methodChoice },
      {
        method: "POST",
        action: `/api/admin/customers/${a._id}/payment-method`,
        encType: "application/json",
      },
    );
  };

  const selectedCreds = CREDENTIAL_MAP.map((c) => {
    const v = a.credentials?.[c.id];
    if (!v?.selected) return null;
    return { ...c, value: v, subFields: collectCredSubFields(c, v) };
  }).filter(Boolean);

  const selectedRefs = REFERRAL_MAP.map((r) => {
    const v = a.referrals?.[r.id];
    if (!v?.selected) return null;
    return { ...r, value: v };
  }).filter(Boolean);

  const licenseFiles = [];
  for (const c of selectedCreds) {
    if (!c.fileKey) continue;
    const url = c.value?.[`file${c.fileIndex}`];
    if (typeof url === "string" && url.startsWith("http")) {
      licenseFiles.push({ label: c.fileKey, url });
    }
  }

  const submittedLabel = a.submittedAt
    ? new Date(a.submittedAt).toLocaleString()
    : null;
  const status = a.status;
  const expandedCred = selectedCreds.find((c) => c.id === expandedCredId);
  const parsedNote = parseNote(shopifyNote);

  return (
    <s-page inlineSize="large" heading={fullName}>
      <s-button
        slot="back-action"
        icon="arrow-left"
        accessibilityLabel="Back to applications"
        onClick={() => navigate("/app/customers")}
      >
        Back
      </s-button>
      {status !== "blocked" && (
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={openModal}
          {...(declining ? { loading: true } : {})}
        >
          Block customer
        </s-button>
      )}

      <s-box paddingBlockStart="large-200" />

      {bannerError && (
        <s-banner tone="critical" heading="Couldn't complete that action">
          <s-paragraph>{bannerError}</s-paragraph>
        </s-banner>
      )}

      {a.shopifyCreateFailed && (
        <s-banner
          tone="warning"
          heading="Shopify sync failed for this customer"
        >
          <s-paragraph>
            {prettyShopifyError(a.shopifyCreateError) ||
              "Unknown error syncing this customer to Shopify."}
          </s-paragraph>
        </s-banner>
      )}

      {a.phoneDuplicate && (
        <s-banner tone="info" heading="Duplicate phone number detected">
          <s-paragraph>
            Another wholesale application uses the same phone number (
            {a.phone || "—"}). Review carefully before approving.
          </s-paragraph>
        </s-banner>
      )}

      {/* ───── Overview: status, name, contact, business — combined ───── */}
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            {a.shopifyCreateFailed ? (
              <s-badge tone="critical">Sync failed</s-badge>
            ) : (
              <s-badge
                tone={
                  status.toLowerCase() === "blocked" ? "critical" : "success"
                }
              >
                {status}
              </s-badge>
            )}
            {submittedLabel && (
              <s-text tone="subdued">Submitted {submittedLabel}</s-text>
            )}
          </s-stack>

          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
            <s-grid-item>
              <KV label="Name" value={fullName} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Email" value={a.email} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Phone" value={a.phone} />
            </s-grid-item>
            <s-grid-item>
              <KV label="Business name" value={a.businessName} />
            </s-grid-item>
            <s-grid-item gridColumn="span 2">
              <KV label="Shopify customer ID" value={a.customerId} />
            </s-grid-item>
          </s-grid>
        </s-stack>
      </s-section>

      {/* ───── Addresses ───── */}
      <s-section heading="Addresses">
        <s-grid gridTemplateColumns="1fr 1fr" gap="large-100">
          <s-grid-item>
            <s-box
              padding="base"
              border="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="tight">
                <s-stack direction="inline" gap="tight" alignItems="center">
                  <s-badge>BILLING</s-badge>
                </s-stack>
                <AddressBlock addr={a.billingAddress} />
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box
              padding="base"
              border="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack direction="block" gap="tight">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-badge>SHIPPING</s-badge>
                  {a.shippingSameAsBilling && (
                    <s-badge tone="info">Same as billing</s-badge>
                  )}
                </s-stack>
                {a.shippingSameAsBilling ? (
                  <s-text tone="subdued">Same as billing address.</s-text>
                ) : (
                  <>
                    <AddressBlock addr={a.shippingAddress} />
                    {(a.shippingAddress?.type || a.shippingPropertyType) && (
                      <s-stack
                        direction="inline"
                        gap="tight"
                        alignItems="center"
                      >
                        <s-text tone="subdued">Property type:</s-text>
                        <s-badge>
                          {a.shippingAddress?.type || a.shippingPropertyType}
                        </s-badge>
                      </s-stack>
                    )}
                  </>
                )}
              </s-stack>
            </s-box>
          </s-grid-item>
        </s-grid>
      </s-section>

      {/* ───── Credentials — chip strip + click-to-expand ───── */}
      <s-section heading={`Credentials (${selectedCreds.length})`}>
        {selectedCreds.length === 0 ? (
          <s-paragraph tone="subdued">No credentials selected.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200">
              {selectedCreds.map((c) => {
                const active = expandedCredId === c.id;
                return (
                  <s-clickable-chip
                    key={c.id}
                    color={active ? "strong" : "base"}
                    accessibilityLabel={`Toggle details for ${c.credKey}`}
                    onClick={() => setExpandedCredId(active ? null : c.id)}
                  >
                    {c.credKey}
                    {c.subFields.length > 0 ? ` (${c.subFields.length})` : ""}
                  </s-clickable-chip>
                );
              })}
            </s-stack>

            {expandedCred && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-badge tone="success">✓</s-badge>
                    <s-text>{expandedCred.credKey}</s-text>
                  </s-stack>
                  {expandedCred.subFields.length === 0 ? (
                    <s-text tone="subdued">
                      No additional details for this credential.
                    </s-text>
                  ) : (
                    <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                      {expandedCred.subFields.map(({ label, value }) => (
                        <s-grid-item key={label}>
                          <KV label={label} value={value} />
                        </s-grid-item>
                      ))}
                    </s-grid>
                  )}
                </s-stack>
              </s-box>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── License files ───── */}
      {licenseFiles.length > 0 && (
        <s-section heading={`License files (${licenseFiles.length})`}>
          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
            {licenseFiles.map((f) => {
              const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.url);
              return (
                <s-grid-item key={f.label}>
                  <s-box border="base" borderRadius="base" padding="none">
                    <s-stack direction="block" gap="none">
                      {isImage ? (
                        <s-image src={f.url} alt={f.label} inlineSize="100%" />
                      ) : (
                        <s-box padding="loose" background="subdued">
                          <s-stack
                            direction="inline"
                            gap="tight"
                            alignItems="center"
                            justifyContent="center"
                          >
                            <s-text>📄</s-text>
                            <s-text tone="subdued">
                              PDF — click below to open
                            </s-text>
                          </s-stack>
                        </s-box>
                      )}
                      <s-box padding="base">
                        <s-stack
                          direction="inline"
                          gap="tight"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          <s-text>{f.label}</s-text>
                          <s-link href={f.url} target="_blank">
                            Open ↗
                          </s-link>
                        </s-stack>
                      </s-box>
                    </s-stack>
                  </s-box>
                </s-grid-item>
              );
            })}
          </s-grid>
        </s-section>
      )}

      {/* ───── Referral source ───── */}
      <s-section heading="Referral source">
        {selectedRefs.length === 0 ? (
          <s-paragraph tone="subdued">No referral source selected.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="small">
            {selectedRefs.map((r) => (
              <s-badge key={r.id}>
                {r.key}
                {r.value?.value ? ` — ${r.value.value}` : ""}
              </s-badge>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* ───── Signature ───── */}
      <s-section heading="Signature">
        {!a.signature ? (
          <s-paragraph tone="subdued">No signature on file.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone={a.signature.type === "drawn" ? "info" : "default"}>
                {a.signature.type === "drawn" ? "Drawn" : "Typed"}
              </s-badge>
              {a.signature.signedAt && (
                <s-text tone="subdued">
                  Signed {new Date(a.signature.signedAt).toLocaleString()}
                </s-text>
              )}
            </s-stack>
            {a.signature.type === "drawn" && a.signature.value ? (
              <s-box
                border="base"
                borderRadius="base"
                padding="none"
                inlineSize="200px"
                blockSize="200px"
              >
                <s-image
                  src={a.signature.value}
                  alt="Customer signature"
                  inlineSize="200px"
                  blockSize="200px"
                />
              </s-box>
            ) : a.signature.type === "typed" && a.signature.value ? (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-text>
                  <em>{a.signature.value}</em>
                </s-text>
              </s-box>
            ) : (
              <s-paragraph tone="subdued">
                Signature value not available.
              </s-paragraph>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Payment details ───── */}
      <s-section heading="Payment details">
        <s-stack direction="block" gap="large-100">
          {!a.payment || !a.payment.method ? (
            <s-paragraph tone="subdued">
              No payment details on file.
            </s-paragraph>
          ) : (
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
              <s-grid-item>
                <KV label="Payment method" value={a.payment.method} />
              </s-grid-item>
              {a.payment.cardholderName && (
                <s-grid-item>
                  <KV
                    label="Cardholder name"
                    value={a.payment.cardholderName}
                  />
                </s-grid-item>
              )}
              {a.payment.cardBrand && (
                <s-grid-item>
                  <KV label="Card brand" value={a.payment.cardBrand} />
                </s-grid-item>
              )}
              {a.payment.cardLast4 && (
                <s-grid-item>
                  <KV
                    label="Card number"
                    value={`•••• •••• •••• ${a.payment.cardLast4}`}
                  />
                </s-grid-item>
              )}
              {(a.payment.cardExpMonth || a.payment.cardExpYear) && (
                <s-grid-item>
                  <KV
                    label="Expiry"
                    value={`${String(a.payment.cardExpMonth || "").padStart(2, "0")} / ${a.payment.cardExpYear || ""}`}
                  />
                </s-grid-item>
              )}
            </s-grid>
          )}

          {/* Change preference + realign all open invoices */}
          <s-box
            padding="base"
            border="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base">
              <s-text>
                <strong>Change payment preference</strong>
              </s-text>
              <s-paragraph tone="subdued">
                Updates the customer&apos;s preference and re-aligns all of
                their unpaid / open invoices to the selected method —
                recomputing the processing fee (card 3% / ACH 1% / check 0%) and
                the due date, and syncing QuickBooks. Paid, partially-paid, and
                in-flight invoices are left unchanged. Future orders use the new
                method too.
              </s-paragraph>
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-select
                  label="Payment method"
                  value={methodChoice}
                  onChange={(e) => setMethodChoice(e.target.value)}
                >
                  <s-option value="card">Credit card (3%)</s-option>
                  <s-option value="ach">ACH / bank (1%)</s-option>
                  <s-option value="check">Check / cheque (0%)</s-option>
                </s-select>
                <s-button
                  variant="primary"
                  onClick={openPrefModal}
                  {...(methodChoice === currentMethod
                    ? { disabled: true }
                    : {})}
                  {...(applyingPref ? { loading: true } : {})}
                >
                  Apply to open invoices
                </s-button>
              </s-stack>
              <s-text tone="subdued">
                Current preference: {currentMethod}
              </s-text>
            </s-stack>
          </s-box>

          {methodHistory.length > 0 && (
            <s-stack direction="block" gap="tight">
              <s-text>
                <strong>Payment method history</strong>
              </s-text>
              <s-table>
                <s-table-header-row>
                  <s-table-header>When</s-table-header>
                  <s-table-header>Change</s-table-header>
                  <s-table-header>Invoices updated</s-table-header>
                  <s-table-header>By</s-table-header>
                  <s-table-header>Source</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {methodHistory.map((h, i) => (
                    <s-table-row key={i}>
                      <s-table-cell>
                        {h.changedAt
                          ? new Date(h.changedAt).toLocaleString()
                          : "—"}
                      </s-table-cell>
                      <s-table-cell>
                        {h.previousMethod || "—"} → {h.newMethod}
                      </s-table-cell>
                      <s-table-cell>{h.invoiceCount ?? 0}</s-table-cell>
                      <s-table-cell>{h.performedBy || "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={h.source === "admin" ? "info" : "default"}
                        >
                          {h.source === "admin" ? "Admin" : "Customer"}
                        </s-badge>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ───── W-9 (taxpayer information) ───── */}
      <s-section heading="W-9 form">
        {!a.w9 || !a.w9.taxClassification ? (
          <s-paragraph tone="subdued">
            No W-9 on file. This practitioner registered before the W-9
            collection step was added — admin can collect manually if a payout
            is required.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="large-100">
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
              <s-grid-item>
                <KV
                  label="Legal name (on tax return)"
                  value={a.w9.legalName || "—"}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Federal tax classification"
                  value={
                    W9_CLASSIFICATION_LABELS[a.w9.taxClassification] ||
                    a.w9.taxClassification
                  }
                />
              </s-grid-item>
              {a.w9.taxClassification === "llc" && a.w9.llcClassification && (
                <s-grid-item>
                  <KV
                    label="LLC sub-classification"
                    value={
                      W9_LLC_LABELS[a.w9.llcClassification] ||
                      a.w9.llcClassification
                    }
                  />
                </s-grid-item>
              )}
              {a.w9.taxClassification === "other" &&
                a.w9.otherClassification && (
                  <s-grid-item>
                    <KV
                      label="Other classification"
                      value={a.w9.otherClassification}
                    />
                  </s-grid-item>
                )}
              {a.w9.exemptPayeeCode && (
                <s-grid-item>
                  <KV label="Exempt payee code" value={a.w9.exemptPayeeCode} />
                </s-grid-item>
              )}
              {a.w9.fatcaCode && (
                <s-grid-item>
                  <KV label="FATCA exemption code" value={a.w9.fatcaCode} />
                </s-grid-item>
              )}
              {a.w9.submittedAt && (
                <s-grid-item>
                  <KV
                    label="W-9 submitted"
                    value={new Date(a.w9.submittedAt).toLocaleString()}
                  />
                </s-grid-item>
              )}
            </s-grid>

            {/* TIN summary pulled from Step 2 — the W-9 PDF reads from here */}
            {a.tax?.taxId && (
              <s-box
                padding="base"
                border="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack direction="block" gap="tight">
                  <s-text>
                    <strong>Taxpayer Identification Number</strong> (from Step
                    2)
                  </s-text>
                  <s-text>
                    {(a.tax.taxIdType || "tin").toUpperCase()}:{" "}
                    {maskTin(a.tax.taxId)}
                  </s-text>
                </s-stack>
              </s-box>
            )}

            {/* W-9 perjury-certification signature — separate from terms signature */}
            {a.w9.signature?.value && (
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone="info">W-9 certification signature</s-badge>
                  {a.w9.signature.signedAt && (
                    <s-text tone="subdued">
                      Signed{" "}
                      {new Date(a.w9.signature.signedAt).toLocaleString()}
                    </s-text>
                  )}
                </s-stack>
                {a.w9.signature.type === "drawn" ? (
                  <s-box
                    padding="base"
                    border="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <img
                      src={a.w9.signature.value}
                      alt="W-9 certification signature"
                      style={{
                        maxWidth: "100%",
                        maxHeight: 160,
                        background: "#fff",
                        padding: 8,
                        borderRadius: 4,
                      }}
                    />
                  </s-box>
                ) : (
                  <s-paragraph>
                    <em>{a.w9.signature.value}</em>
                  </s-paragraph>
                )}
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Commission payout bank ───── */}
      <s-section heading="Commission payout bank">
        {!a.commission || !a.commission.enabled ? (
          <s-paragraph tone="subdued">
            No commission bank account on file. Practitioner opted out at signup
            — admin can collect later if commissions need to be paid out.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="large-100">
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
              <s-grid-item>
                <KV
                  label="Account holder"
                  value={a.commission.bankAccountName || "—"}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Routing number"
                  value={a.commission.bankRoutingNumber || "—"}
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Account number"
                  value={
                    a.commission.bankAccountLast4
                      ? `•••• •••• ${a.commission.bankAccountLast4}`
                      : "—"
                  }
                />
              </s-grid-item>
              <s-grid-item>
                <KV
                  label="Account type"
                  value={a.commission.bankAccountType || "—"}
                />
              </s-grid-item>
              {a.commission.updatedAt && (
                <s-grid-item>
                  <KV
                    label="Last updated"
                    value={new Date(a.commission.updatedAt).toLocaleString()}
                  />
                </s-grid-item>
              )}
              {a.commission.sourcedFromPaymentAch && (
                <s-grid-item>
                  <s-stack direction="block" gap="tight">
                    <s-text tone="subdued">Source</s-text>
                    <s-badge tone="info">Same as ACH payment account</s-badge>
                  </s-stack>
                </s-grid-item>
              )}
            </s-grid>
          </s-stack>
        )}
      </s-section>

      {/* ───── Synced data — parsed into a readable table ───── */}
      <s-section heading="Data synced to Shopify customer note">
        <s-paragraph tone="subdued">
          These are the exact key / value pairs saved to the Shopify customer
          record's note field.
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header>Field</s-table-header>
            <s-table-header>Value</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {parsedNote.map((row, i) => (
              <s-table-row key={`${row.key}-${i}`}>
                <s-table-cell>
                  <s-text>{row.key}</s-text>
                </s-table-cell>
                <s-table-cell>
                  {row.isUrl ? (
                    <s-link href={row.value} target="_blank">
                      {truncate(row.value, 60)} ↗
                    </s-link>
                  ) : row.value === "True" ? (
                    <s-badge tone="success">True</s-badge>
                  ) : row.value === "False" ? (
                    <s-badge>False</s-badge>
                  ) : (
                    <s-text>{row.value || "—"}</s-text>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-modal
        ref={modalRef}
        id="block-customer-modal"
        heading="Block this customer?"
        accessibilityLabel="Block customer confirmation"
      >
        <s-paragraph>
          This customer will be tagged as Blocked in Shopify. They keep their
          record and order history, but won't be able to place new wholesale
          orders. You can reverse this later.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={onConfirmBlock}
          {...(declining ? { loading: true } : {})}
        >
          Block customer
        </s-button>
        <s-button slot="secondary-actions" onClick={closeModal}>
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        ref={prefModalRef}
        id="apply-payment-method-modal"
        heading="Apply payment method to open invoices?"
        accessibilityLabel="Confirm payment method change"
      >
        <s-paragraph>
          This sets the customer&apos;s payment preference to{" "}
          <strong>{methodChoice}</strong> and re-aligns all of their unpaid /
          open invoices — recomputing the processing fee and due date and
          updating QuickBooks. Paid, partially-paid, and in-flight invoices are
          not touched. Future orders will use the new method too.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={onConfirmApplyMethod}
          {...(applyingPref ? { loading: true } : {})}
        >
          Apply
        </s-button>
        <s-button slot="secondary-actions" onClick={closePrefModal}>
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

function AddressBlock({ addr }) {
  if (!addr || (!addr.line1 && !addr.city && !addr.zip)) {
    return <s-text tone="subdued">No address on file.</s-text>;
  }
  return (
    <s-stack direction="block" gap="none">
      {addr.line1 && <s-text>{addr.line1}</s-text>}
      {addr.line2 && <s-text>{addr.line2}</s-text>}
      <s-text>
        {[addr.city, addr.state, addr.zip].filter(Boolean).join(", ")}
      </s-text>
      {addr.country && <s-text>{addr.country}</s-text>}
    </s-stack>
  );
}

// Build a structured sub-field list per credential so the chip-expand panel
// can render a clean grid instead of bespoke layouts per credential type.
function collectCredSubFields(c, v) {
  const items = [];
  if (c.id === "bio-energetic") {
    items.push({ label: "System name", value: v.systemName });
    items.push({ label: "System serial", value: v.systemSerial });
  } else if (c.id === "medical") {
    items.push({
      label: "Professional credentials",
      value: v.professionalCredentials,
    });
  } else if (c.id === "qest4") {
    items.push({ label: "Serial number", value: v.serialNumber });
    items.push({ label: "System type", value: v.systemType });
  } else if (c.id === "other") {
    items.push({ label: "Description", value: v.description });
  }
  if (c.fileKey) {
    const url = v[`file${c.fileIndex}`];
    if (typeof url === "string" && url.startsWith("http")) {
      items.push({ label: c.fileKey, value: url, isUrl: true });
    }
  }
  return items.filter((it) => it.value);
}

// Parse the raw Shopify note text into structured { key, value, isUrl } rows.
function parseNote(note) {
  if (!note) return [];
  return note
    .split("\n")
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx === -1) return { key: line, value: "", isUrl: false };
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      const isUrl = /^https?:\/\//i.test(value);
      return { key, value, isUrl };
    })
    .filter((r) => r.key);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Normalize a stored payment method to the card/ach/check enum used by the
// selector. Mirrors customer.utils.normalizePaymentMethod (kept inline so
// this render module imports no service-side code).
function normalizeMethod(raw) {
  const v = String(raw || "")
    .trim()
    .toLowerCase();
  if (v === "check" || v === "cheque") return "check";
  if (v === "ach" || v === "bank" || v === "bank-transfer") return "ach";
  return "card";
}

// Strip the leading "[fieldName] " prefix(es) that ShopifyUserError adds to
// its Error.message — useful in logs, ugly in the admin UI.
function prettyShopifyError(text) {
  if (!text) return "";
  return text
    .split(";")
    .map((part) => part.replace(/^\s*\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .join("; ");
}
