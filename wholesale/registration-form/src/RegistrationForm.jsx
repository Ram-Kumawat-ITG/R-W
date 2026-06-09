import { useEffect, useState, useRef } from "react";
import { useForm } from "react-hook-form";
import { yupResolver } from "@hookform/resolvers/yup";
import { fullSchema } from "./schema/full.schema";
import { step1Fields } from "./schema/step1.schema";
import { step2Fields } from "./schema/step2.schema";
import { step3Fields } from "./schema/step3.schema";
import { step4Fields } from "./schema/step4.schema";
import { buildFormData } from "./utils/buildFormData";
import ApiService from "./services/ApiService";
import { useStepValidation } from "./hooks/useStepValidation";
import StepIndicator from "./components/StepIndicator";
import Step1AboutYou from "./components/Step1AboutYou";
import Step2AddressTax from "./components/Step2AddressTax";
import Step3Payment from "./components/Step3Payment";
import Step4W9 from "./components/Step4W9";
import { CREDENTIALS, REFERRALS } from "./constants";
import "./styles/variables.css";
import "./styles/registration-form.css";

const credentialDefaults = {};
CREDENTIALS.forEach((cred) => {
  const fields = { selected: false };
  cred.docs.forEach((doc, i) => {
    if (doc.type === "file") fields[`file${i}`] = null;
    else if (doc.key) fields[doc.key] = "";
  });
  credentialDefaults[cred.id] = fields;
});

const referralDefaults = {};
REFERRALS.forEach((ref) => {
  referralDefaults[ref.id] = ref.field
    ? { selected: false, value: "" }
    : { selected: false };
});

const defaultValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  password: "",
  businessName: "",
  credentials: credentialDefaults,
  referrals: referralDefaults,
  billingAddress: {
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    country: "United States",
  },
  shippingSameAsBilling: true,
  shippingAddress: null,
  shippingPropertyType: "Residential",
  resellsProducts: true,
  tax: {
    taxIdType: "ein",
    taxId: "",
    salesPermit: "",
    exemptState: "",
    itemsToResell: "",
    businessActivity: "",
  },
  payment: {
    method: "check",
    cardholderName: "",
    paymentToken: "",
    cardBrand: "",
    cardLast4: "",
    achAccountName: "",
    achRoutingNumber: "",
    achAccountNumber: "",
    achAccountType: "",
  },
  // Commission bank — hidden behind a button on Step 3. enabled flips to
  // true when practitioner opts in. Field-level required validation gates
  // on `enabled` (see step3.schema.js).
  commission: {
    enabled: false,
    useSamePaymentAccount: false,
    bankAccountName: "",
    bankRoutingNumber: "",
    bankAccountNumber: "",
    bankAccountType: "",
  },
  signature: { drawn: null },
  // Step 4 — W-9 form. legalName auto-fills from firstName + lastName on
  // mount (see Step4W9.jsx). Tax classification is required; sub-fields
  // (llcClassification / otherClassification) gate on selection.
  w9: {
    legalName: "",
    taxClassification: "",
    llcClassification: "",
    otherClassification: "",
    exemptPayeeCode: "",
    fatcaCode: "",
    signature: { drawn: null },
  },
  subscribeNews: false,
  termsAccepted: false,
};

// Walk a react-hook-form errors tree and produce a flat list of { path, message, type }.
// Helpful for console output — the nested shape is hard to read at a glance.
function flattenErrors(node, prefix = "") {
  const out = [];
  if (!node || typeof node !== "object") return out;
  // A leaf error has a `message` string.
  if (typeof node.message === "string") {
    out.push({
      path: prefix || "(root)",
      message: node.message,
      type: node.type,
    });
    return out;
  }
  for (const key of Object.keys(node)) {
    // Skip RHF internals
    if (key === "ref" || key === "types") continue;
    const child = node[key];
    if (child && typeof child === "object") {
      out.push(...flattenErrors(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return out;
}

function Toast({ severity, message, onDismiss }) {
  // Auto-dismiss after 4s — but only register the timeout once on mount
  return (
    <div className={`rf-toast ${severity}`} onClick={onDismiss}>
      {message}
    </div>
  );
}

function SuccessScreen() {
  return (
    <div className="rf-page">
      <main className="rf-main">
        <div className="rf-card">
          <div className="rf-success">
            <div className="check-circle">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="28"
                height="28"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <h2>Application received</h2>
            <div className="rf-next-steps">
              <h3>What happens next</h3>
              <ol>
                <li>We verify your credentials and tax information</li>
                <li>We may reach out if we have any questions</li>
                <li>Start shopping at wholesale pricing</li>
              </ol>
              <button
                onClick={() => {
                  window.location.href = "/account/login";
                }}
                style={{
                  background: "var(--color-primary)",
                  color: "#fff",
                  border: "none",
                  padding: "10px 20px",
                  fontSize: 14,
                  fontWeight: 500,
                  borderRadius: 5,
                  cursor: "pointer",
                  fontFamily: "var(--font-family)",
                  marginTop: 16,
                }}
              >
                Go to login
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function FormBody({ onBack }) {
  const [currentStep, setCurrentStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [successView, setSuccessView] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null);
  const collectTokenResolverRef = useRef(null);
  const submitIntentRef = useRef(false);
  const serverErrorNavRef = useRef(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitted },
    setValue,
    trigger,
    clearErrors,
    setError,
  } = useForm({
    mode: "onTouched",
    reValidateMode: "onChange",
    resolver: yupResolver(fullSchema),
    defaultValues,
  });

  const validateStep = useStepValidation(trigger);

  // Clear stale errors and banner every time the step changes.
  // trigger(step2Fields) runs the full yupResolver which evaluates step-3 fields
  // (signature, cardholderName) even though they aren't triggered — those errors
  // can leak into RHF state before clearErrors() in next() fires. Clearing again
  // here (one render later) guarantees the new step always starts clean.
  useEffect(() => {
    if (serverErrorNavRef.current) {
      serverErrorNavRef.current = false;
      return;
    }
    setErrorBanner(null);
    clearErrors();
  }, [currentStep, clearErrors]);

  const showToast = (severity, message) => {
    setToast({ severity, message });
    setTimeout(() => setToast(null), 4000);
  };

  const next = async () => {
    const fieldsByStep = {
      1: step1Fields,
      2: step2Fields,
      3: step3Fields,
    };
    const fields = fieldsByStep[currentStep] || step1Fields;
    const ok = await validateStep(fields);
    if (!ok) {
      console.warn(
        `[RegistrationForm] Step ${currentStep} blocked — fix the errors above.`,
      );
      setErrorBanner("Oops! A few fields need your attention.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setToast(null);
    setErrorBanner(null);
    clearErrors();
    setCurrentStep((s) => Math.min(s + 1, 4));
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const prev = () => {
    setToast(null);
    setErrorBanner(null);
    clearErrors();
    setCurrentStep((s) => Math.max(s - 1, 1));
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onValid = async (values) => {
    submitIntentRef.current = false;
    setSubmitting(true);
    try {
      // Tokenize card via Collect.js — raw card data never touches our servers.
      const tokenResult = await new Promise((resolve, reject) => {
        collectTokenResolverRef.current = { resolve, reject };
        const tid = setTimeout(() => {
          if (collectTokenResolverRef.current) {
            collectTokenResolverRef.current.reject(
              new Error("Please check your card details and try again."),
            );
            collectTokenResolverRef.current = null;
          }
        }, 10000);
        collectTokenResolverRef.current._tid = tid;
        window.CollectJS.startPaymentRequest();
      });

      const cardPayload = {
        method: values.payment.method,
        cardholderName: values.payment.cardholderName,
        paymentToken: tokenResult.token,
        cardBrand: tokenResult.cardBrand,
        cardLast4: tokenResult.cardLast4,
      };

      // Include ACH details when ACH is the preferred method. We need the
      // FULL routing + account number so the backend can create an ACH
      // billing in NMI's Customer Vault. The backend uses the full number
      // for NMI only — it stores only the last 4 in MongoDB (the full
      // account number is never persisted in our DB).
      //
      // ACH bank account numbers are NOT in PCI scope (PCI applies to card
      // data only); they're governed by NACHA, which our payment processor
      // (NMI) is responsible for handling. Passing the full number through
      // our backend to NMI is the standard pattern.
      if (values.payment.method === "ach") {
        cardPayload.achAccountName = values.payment.achAccountName;
        cardPayload.achRoutingNumber = values.payment.achRoutingNumber;
        cardPayload.achAccountNumber = values.payment.achAccountNumber; // full — needed for NMI
        cardPayload.achAccountLast4 = (
          values.payment.achAccountNumber || ""
        ).slice(-4); // kept for backwards compat / DB display
        cardPayload.achAccountType = values.payment.achAccountType;
      }

      // Commission bank — if enabled, include FULL details (account name,
      // routing, full account number, type). useSamePaymentAccount is a
      // UI-only flag (already used to mirror payment ACH values into the
      // commission fields client-side) and isn't persisted on its own.
      const commissionPayload = values.commission?.enabled
        ? {
            enabled: true,
            bankAccountName: values.commission.bankAccountName,
            bankRoutingNumber: values.commission.bankRoutingNumber,
            bankAccountNumber: values.commission.bankAccountNumber,
            bankAccountLast4: (
              values.commission.bankAccountNumber || ""
            ).slice(-4),
            bankAccountType: values.commission.bankAccountType,
            sourcedFromPaymentAch: Boolean(
              values.commission.useSamePaymentAccount &&
                values.payment.method === "ach",
            ),
          }
        : { enabled: false };

      // W-9 payload — everything except the signature (sent as a File).
      const w9Payload = {
        legalName: values.w9?.legalName || "",
        taxClassification: values.w9?.taxClassification || "",
        llcClassification: values.w9?.llcClassification || "",
        otherClassification: values.w9?.otherClassification || "",
        exemptPayeeCode: values.w9?.exemptPayeeCode || "",
        fatcaCode: values.w9?.fatcaCode || "",
      };

      const payload = {
        ...values,
        payment: cardPayload,
        commission: commissionPayload,
        w9: w9Payload,
      };

      // Signatures handled separately so we can attach each PNG as a File.
      // Two signatures: Step 3 (terms / payment authorization) and Step 4
      // (W-9 IRS certification). Backend persists both as Shopify Files.
      const fd = buildFormData({
        ...payload,
        signature: undefined,
        w9: { ...w9Payload }, // strip the signature object from the W-9 payload too
      });
      if (values.signature?.drawn) {
        fd.append("signatureFile", values.signature.drawn, "signature.png");
      }
      if (values.w9?.signature?.drawn) {
        fd.append(
          "w9SignatureFile",
          values.w9.signature.drawn,
          "w9-signature.png",
        );
      }

      await ApiService.submitRegistration(fd);
      setSuccessView(true);
    } catch (err) {
      const fieldErrors = err?.responseData?.result?.fieldErrors;
      if (fieldErrors?.length) {
        serverErrorNavRef.current = true;
        setCurrentStep(1);
        setErrorBanner("Oops! A few fields need your attention.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        fieldErrors.forEach(({ field, message }) => {
          setError(field, { type: "server", message });
        });
      } else {
        showToast("error", err?.message || "Submit failed. Please try again.");
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (successView) return <SuccessScreen />;

  return (
    <div className="rf-page">
      <header className="rf-topbar">
        <div className="rf-topbar-inner">
          <div>
            <span className="rf-brand">Natural Solutions</span>
            <span className="rf-brand-sub">Wholesale</span>
          </div>
          {/* <a href="#" className="rf-help-link">Need help?</a> */}
        </div>
      </header>

      <StepIndicator currentStep={currentStep} onStepClick={setCurrentStep} />

      <main className="rf-main">
        <div className="rf-card">
          <form
            onSubmit={(e) => {
              if (!submitIntentRef.current) {
                e.preventDefault();
                return;
              }
              handleSubmit(onValid, (errs) => {
                submitIntentRef.current = false;
                setErrorBanner("Oops! A few fields need your attention.");
                window.scrollTo({ top: 0, behavior: "smooth" });
                console.error(
                  "[RegistrationForm] submit blocked by validation:",
                  errs,
                );
                console.table(
                  flattenErrors(errs).map(({ path, message, type }) => ({
                    path,
                    message,
                    type,
                  })),
                );
              })(e);
            }}
            noValidate
          >
            {errorBanner && (
              <div className="rf-error-banner">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  width="18"
                  height="18"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{errorBanner}</span>
                <button
                  type="button"
                  className="rf-error-banner-close"
                  onClick={() => setErrorBanner(null)}
                >
                  ×
                </button>
              </div>
            )}
            {currentStep === 1 && (
              <Step1AboutYou
                control={control}
                errors={errors}
                setValue={setValue}
                trigger={trigger}
                clearErrors={clearErrors}
              />
            )}
            {currentStep === 2 && (
              <Step2AddressTax
                control={control}
                errors={errors}
                setValue={setValue}
                clearErrors={clearErrors}
              />
            )}
            {/*
              Step 3 stays MOUNTED across steps 3 + 4 (hidden via inline style
              when not active) so the Collect.js card iframe doesn't tear
              down and lose its tokenization context. Step 4 is rendered
              normally — it has no third-party iframe to preserve.
            */}
            <div
              style={
                currentStep !== 3
                  ? {
                      position: "absolute",
                      visibility: "hidden",
                      pointerEvents: "none",
                      width: "100%",
                    }
                  : undefined
              }
            >
              <Step3Payment
                control={control}
                errors={errors}
                setValue={setValue}
                onEditBilling={prev}
                isSubmitted={isSubmitted}
                collectTokenResolverRef={collectTokenResolverRef}
              />
            </div>
            {currentStep === 4 && (
              <Step4W9
                control={control}
                errors={errors}
                setValue={setValue}
                isSubmitted={isSubmitted}
                onEditStep1={() => setCurrentStep(1)}
                onEditStep2={() => setCurrentStep(2)}
              />
            )}

            <div className="rf-actions">
              {currentStep === 1 ? (
                <span />
              ) : (
                <button
                  type="button"
                  className="rf-btn rf-btn-secondary"
                  onClick={prev}
                  disabled={submitting}
                >
                  <svg className="rf-icon-svg" viewBox="0 0 24 24">
                    <path d="M19 12H5M11 19l-7-7 7-7" />
                  </svg>
                  Back
                </button>
              )}
              {currentStep < 4 ? (
                <button
                  type="button"
                  className="rf-btn rf-btn-primary"
                  onClick={next}
                >
                  Continue
                  <svg className="rf-icon-svg" viewBox="0 0 24 24">
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  className="rf-btn rf-btn-primary"
                  disabled={submitting}
                  onClick={() => {
                    submitIntentRef.current = true;
                  }}
                >
                  {submitting ? "Submitting…" : "Submit application"}
                  {!submitting && (
                    <svg className="rf-icon-svg" viewBox="0 0 24 24">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </form>
        </div>
      </main>

      <footer className="rf-footer">
        © 2026 Natural Solutions Wholesale, LLC · <a href="#">Privacy</a> ·{" "}
        <a href="#">Terms</a>
      </footer>

      {toast && (
        <Toast
          severity={toast.severity}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

export default function RegistrationForm({ onBack }) {
  return <FormBody onBack={onBack} />;
}
