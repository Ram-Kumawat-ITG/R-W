import { useEffect, useRef, useState } from "react";
import mongoose from "mongoose";
import {
  useLoaderData,
  useNavigate,
  useFetcher,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import connectDB from "../services/APIService/mongo.service";
import WholesaleApplication from "../models/wholesaleApplication.server";
import { buildShopifyNote } from "../services/shopify/shopify.utils";
import { CREDENTIAL_MAP, REFERRAL_MAP } from "../services/shopify/shopify.constants";
import { KV } from "../components/admin-ui";

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
  const reviewFetcher = useFetcher();
  const [bannerError, setBannerError] = useState(null);
  const [expandedCredId, setExpandedCredId] = useState(null);
  const modalRef = useRef(null);

  const fullName =
    `${a.firstName || ""} ${a.lastName || ""}`.trim() || "(no name)";
  const declining =
    fetcher.state === "submitting" || fetcher.state === "loading";
  const reviewing =
    reviewFetcher.state === "submitting" || reviewFetcher.state === "loading";
  const isApproved = a.status === "approved";
  const loadedToastShown = useRef(false);
  // Track which response we've handled so React-Router's automatic
  // post-action revalidation doesn't re-trigger toast / navigate / banner
  // on every subsequent render.
  const handledDeclineRef = useRef(null);
  const handledReviewRef = useRef(null);

  // One-time toast confirming data fetched + showing current approval status.
  useEffect(() => {
    if (loadedToastShown.current) return;
    loadedToastShown.current = true;
    if (a.shopifyCreateFailed) {
      shopify?.toast?.show(`Loaded ${fullName} — Shopify sync failed`, {
        isError: true,
      });
    } else if (isApproved) {
      shopify?.toast?.show(`${fullName} — Approved`);
    } else {
      shopify?.toast?.show(`Loaded ${fullName} — Pending review`);
    }
  }, [isApproved, a.shopifyCreateFailed, fullName, shopify]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.state !== "idle") return;
    if (handledDeclineRef.current === fetcher.data) return;
    handledDeclineRef.current = fetcher.data;

    if (fetcher.data.status === "success") {
      shopify?.toast?.show("Customer declined and removed.");
      navigate("/app/customers");
    } else if (fetcher.data.status === "error") {
      setBannerError(
        fetcher.data.result?.detail ||
          fetcher.data.message ||
          "Decline failed. Please retry.",
      );
    }
  }, [fetcher.data, fetcher.state, navigate, shopify]);

  // Review / un-review response → toast on success, banner on error. The
  // loader is auto-revalidated by React-Router after the fetcher action, so
  // we do NOT call revalidator.revalidate() manually (doing so would change
  // revalidator's reference and re-fire this effect in a loop).
  useEffect(() => {
    if (!reviewFetcher.data) return;
    if (reviewFetcher.state !== "idle") return;
    if (handledReviewRef.current === reviewFetcher.data) return;
    handledReviewRef.current = reviewFetcher.data;

    if (reviewFetcher.data.status === "success") {
      shopify?.toast?.show(
        reviewFetcher.data.message || "Customer updated.",
      );
    } else if (reviewFetcher.data.status === "error") {
      setBannerError(
        reviewFetcher.data.result?.detail ||
          reviewFetcher.data.message ||
          "Action failed. Please retry.",
      );
    }
  }, [reviewFetcher.data, reviewFetcher.state, shopify]);

  const toggleReview = () => {
    setBannerError(null);
    reviewFetcher.submit(null, {
      method: "POST",
      action: isApproved
        ? `/api/admin/customers/${a._id}/unreview`
        : `/api/admin/customers/${a._id}/review`,
    });
  };

  const onConfirmDecline = () => {
    setBannerError(null);
    closeModal();
    fetcher.submit(null, {
      method: "POST",
      action: `/api/admin/customers/${a._id}/decline`,
    });
  };
  const openModal = () => modalRef.current?.showOverlay?.();
  const closeModal = () => modalRef.current?.hideOverlay?.();

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
      <s-button
        slot="primary-action"
        variant={isApproved ? "secondary" : "primary"}
        tone={isApproved ? "critical" : undefined}
        icon={isApproved ? "undo" : "check"}
        onClick={toggleReview}
        {...(reviewing ? { loading: true } : {})}
      >
        {isApproved ? "Revoke" : "Review"}
      </s-button>
      <s-button
        slot="secondary-actions"
        variant="primary"
        tone="critical"
        onClick={openModal}
        {...(declining ? { loading: true } : {})}
      >
        Decline
      </s-button>

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
            {a.shopifyCreateError ||
              "Unknown error syncing this customer to Shopify."}
          </s-paragraph>
        </s-banner>
      )}

      {/* ───── Overview: status, name, contact, business — combined ───── */}
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            {a.shopifyCreateFailed ? (
              <s-badge tone="critical">Sync failed</s-badge>
            ) : isApproved ? (
              <s-badge tone="success">Approved</s-badge>
            ) : (
              <s-badge>Pending</s-badge>
            )}
            {submittedLabel && (
              <s-text tone="subdued">Submitted {submittedLabel}</s-text>
            )}
            {a.reviewedAt && isApproved && (
              <s-text tone="subdued">
                · Reviewed {new Date(a.reviewedAt).toLocaleString()}
              </s-text>
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
              <s-paragraph tone="subdued">Signature value not available.</s-paragraph>
            )}
          </s-stack>
        )}
      </s-section>

      {/* ───── Payment details ───── */}
      <s-section heading="Payment details">
        {!a.payment || !a.payment.method ? (
          <s-paragraph tone="subdued">No payment details on file.</s-paragraph>
        ) : (
          <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="large-100">
            <s-grid-item>
              <KV label="Payment method" value={a.payment.method} />
            </s-grid-item>
            {a.payment.cardholderName && (
              <s-grid-item>
                <KV label="Cardholder name" value={a.payment.cardholderName} />
              </s-grid-item>
            )}
            {a.payment.cardBrand && (
              <s-grid-item>
                <KV label="Card brand" value={a.payment.cardBrand} />
              </s-grid-item>
            )}
            {a.payment.cardLast4 && (
              <s-grid-item>
                <KV label="Card number" value={`•••• •••• •••• ${a.payment.cardLast4}`} />
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
        id="decline-customer-modal"
        heading="Decline and delete this customer?"
        accessibilityLabel="Decline customer confirmation"
      >
        <s-paragraph>
          This will remove the customer from Shopify, delete their record from
          the database, and send them a rejection email. This cannot be undone.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={onConfirmDecline}
          {...(declining ? { loading: true } : {})}
        >
          Decline &amp; delete
        </s-button>
        <s-button slot="secondary-actions" onClick={closeModal}>
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
