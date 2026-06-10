import { useEffect } from "react";
import { Controller, useWatch } from "react-hook-form";

const TAX_CLASSIFICATIONS = [
  { id: "individual", label: "Individual / sole proprietor or single-member LLC" },
  { id: "c_corp", label: "C Corporation" },
  { id: "s_corp", label: "S Corporation" },
  { id: "partnership", label: "Partnership" },
  { id: "trust_estate", label: "Trust / estate" },
  { id: "llc", label: "Limited liability company (LLC)" },
  { id: "other", label: "Other (specify)" },
];

const LLC_SUB = [
  { id: "C", label: "C — C Corporation" },
  { id: "S", label: "S — S Corporation" },
  { id: "P", label: "P — Partnership" },
];

// Compact read-only summary of fields the W-9 needs but already collected
// in earlier steps. The IRS form combines name, business name, address,
// and TIN into the W-9 layout, but our registration captured them in
// Steps 1 & 2 — surface them here so the practitioner sees exactly what
// will be transmitted to the IRS-equivalent record without re-typing.
function ReusedFieldsSummary({ control, onEditStep1, onEditStep2 }) {
  const firstName = useWatch({ control, name: "firstName" }) || "";
  const lastName = useWatch({ control, name: "lastName" }) || "";
  const businessName = useWatch({ control, name: "businessName" }) || "";
  const ba = useWatch({ control, name: "billingAddress" }) || {};
  const tax = useWatch({ control, name: "tax" }) || {};

  const fullName = `${firstName} ${lastName}`.trim();
  const streetLine = [ba.line1, ba.line2].filter(Boolean).join(", ");
  const cityLine = [ba.city, ba.state, ba.zip].filter(Boolean).join(" ");

  const tinLabel =
    tax.taxIdType === "ssn"
      ? "SSN"
      : tax.taxIdType === "ein"
        ? "EIN"
        : "TIN";
  const tinMasked = tax.taxId ? maskTin(tax.taxId) : "(not set)";

  return (
    <div className="rf-billing-summary" style={{ marginBottom: 18 }}>
      <div className="rf-billing-head">
        <span className="rf-billing-label">
          From earlier steps — used to complete your W-9
        </span>
      </div>
      <div className="rf-billing-body">
        <div>
          <strong>Name on tax return:</strong> {fullName || "(not set)"}{" "}
          <button
            type="button"
            className="rf-billing-edit"
            onClick={onEditStep1}
            style={{ marginLeft: 8 }}
          >
            Edit Step 1
          </button>
        </div>
        {businessName && (
          <div>
            <strong>Business name:</strong> {businessName}
          </div>
        )}
        <div>
          <strong>Address:</strong>{" "}
          {streetLine || cityLine || ba.country ? (
            <>
              {streetLine}
              {streetLine && cityLine ? ", " : ""}
              {cityLine}
              {(streetLine || cityLine) && ba.country ? ", " : ""}
              {ba.country}
            </>
          ) : (
            "(not set)"
          )}{" "}
          <button
            type="button"
            className="rf-billing-edit"
            onClick={onEditStep2}
            style={{ marginLeft: 8 }}
          >
            Edit Step 2
          </button>
        </div>
        <div>
          <strong>{tinLabel}:</strong> {tinMasked}
        </div>
      </div>
    </div>
  );
}

function maskTin(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "•••••";
  return `•••-••-${digits.slice(-4)}`;
}

export default function Step4W9({
  control,
  errors,
  setValue,
  onEditStep1,
  onEditStep2,
}) {
  const w9Errors = errors?.w9 || {};
  const taxClassification = useWatch({
    control,
    name: "w9.taxClassification",
  });
  const w9LegalName = useWatch({ control, name: "w9.legalName" });
  const step1First = useWatch({ control, name: "firstName" }) || "";
  const step1Last = useWatch({ control, name: "lastName" }) || "";

  // Pre-fill legal name from Step 1 the first time Step 4 mounts (option B
  // — editable). If the practitioner clears it, we don't keep re-stamping.
  useEffect(() => {
    if (!w9LegalName && (step1First || step1Last)) {
      setValue("w9.legalName", `${step1First} ${step1Last}`.trim(), {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step1First, step1Last]);

  return (
    <section className="rf-step">
      <h1 className="rf-step-title">Form W-9 — taxpayer information</h1>
      <p className="rf-step-subtitle">
        Required by the IRS for any payment we make to you (including
        commission payouts). Fields we've already collected appear below for
        confirmation — edit them in earlier steps if anything's wrong.
      </p>

      <ReusedFieldsSummary
        control={control}
        onEditStep1={onEditStep1}
        onEditStep2={onEditStep2}
      />

      {/* Line 1 — legal name (editable override of Step 1) */}
      <div className="rf-field">
        <label className="rf-label">
          Name (as shown on your income tax return) <span className="rf-req">*</span>
        </label>
        <Controller
          name="w9.legalName"
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Full legal name"
              className={`rf-input ${w9Errors.legalName ? "error" : ""}`}
            />
          )}
        />
        {w9Errors.legalName && (
          <p className="rf-help error">{w9Errors.legalName.message}</p>
        )}
        <p className="rf-help">
          Pre-filled from Step 1. Edit only if your tax return uses a different
          legal name.
        </p>
      </div>

      {/* Line 3 — federal tax classification */}
      <div className="rf-field">
        <label className="rf-label">
          Federal tax classification <span className="rf-req">*</span>
        </label>
        <Controller
          name="w9.taxClassification"
          control={control}
          render={({ field }) => (
            <div className="rf-w9-class-list">
              {TAX_CLASSIFICATIONS.map((c) => (
                <label
                  key={c.id}
                  className={`rf-w9-class-row ${field.value === c.id ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="w9TaxClassification"
                    checked={field.value === c.id}
                    onChange={() => field.onChange(c.id)}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          )}
        />
        {w9Errors.taxClassification && (
          <p className="rf-help error">{w9Errors.taxClassification.message}</p>
        )}
      </div>

      {/* Line 3a — LLC sub-classification (conditional) */}
      {taxClassification === "llc" && (
        <div className="rf-field">
          <label className="rf-label">
            LLC tax classification <span className="rf-req">*</span>
          </label>
          <Controller
            name="w9.llcClassification"
            control={control}
            render={({ field }) => (
              <select
                {...field}
                className={`rf-select ${w9Errors.llcClassification ? "error" : ""}`}
              >
                <option value="">Select…</option>
                {LLC_SUB.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          />
          {w9Errors.llcClassification && (
            <p className="rf-help error">{w9Errors.llcClassification.message}</p>
          )}
          <p className="rf-help">
            Required by the IRS for LLCs (C, S, or P). Skip if your LLC is a
            single-member disregarded entity — choose "Individual" above instead.
          </p>
        </div>
      )}

      {/* Line 3b — Other classification text (conditional) */}
      {taxClassification === "other" && (
        <div className="rf-field">
          <label className="rf-label">
            Other classification <span className="rf-req">*</span>
          </label>
          <Controller
            name="w9.otherClassification"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="Describe your tax classification"
                className={`rf-input ${w9Errors.otherClassification ? "error" : ""}`}
              />
            )}
          />
          {w9Errors.otherClassification && (
            <p className="rf-help error">
              {w9Errors.otherClassification.message}
            </p>
          )}
        </div>
      )}

      {/* Line 4 — Exemptions (optional) */}
      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">Exempt payee code (optional)</label>
          <Controller
            name="w9.exemptPayeeCode"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="e.g. 1, 5, 13"
                maxLength={4}
                className="rf-input"
              />
            )}
          />
          <p className="rf-help">Leave blank unless you're a specific
            entity type — see IRS W-9 instructions, page 3.</p>
        </div>
        <div>
          <label className="rf-label">FATCA exemption code (optional)</label>
          <Controller
            name="w9.fatcaCode"
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="e.g. A, B, M"
                maxLength={4}
                className="rf-input"
              />
            )}
          />
          <p className="rf-help">Only applies to accounts maintained outside
            the U.S.</p>
        </div>
      </div>

      {/* Part II — Certification (text only — signature is collected once on Step 3) */}
      <div className="rf-divider">
        <h2 className="rf-section-label">Part II — Certification</h2>
      </div>

      <div className="rf-auth-block">
        <p className="rf-auth-heading">Under penalties of perjury, I certify that:</p>
        <ol style={{ paddingLeft: 18, margin: "8px 0", lineHeight: 1.5 }}>
          <li>
            The number shown on this form is my correct taxpayer identification
            number (or I am waiting for a number to be issued to me).
          </li>
          <li>
            I am not subject to backup withholding because: (a) I am exempt
            from backup withholding, or (b) I have not been notified by the
            Internal Revenue Service (IRS) that I am subject to backup
            withholding as a result of a failure to report all interest or
            dividends, or (c) the IRS has notified me that I am no longer
            subject to backup withholding.
          </li>
          <li>I am a U.S. citizen or other U.S. person.</li>
          <li>
            The FATCA code(s) entered on this form (if any) indicating that I
            am exempt from FATCA reporting is correct.
          </li>
        </ol>
        <p className="rf-auth-footer" style={{ marginTop: 10 }}>
          Your signature on Step 3 also certifies the statements above for the
          W-9 form. You do not need to sign again.
        </p>
      </div>
    </section>
  );
}
