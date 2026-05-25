import { useEffect, useRef, useState } from "react";
import { Controller } from "react-hook-form";

const COLLECT_JS_URL = "https://sandbox.nmi.com/token/Collect.js";

function loadCollectJs(tokenizationKey) {
  return new Promise((resolve, reject) => {
    if (window.CollectJS) {
      resolve();
      return;
    }
    if (!tokenizationKey) {
      reject(
        new Error("VITE_NMI_TOKENIZATION_KEY is not set. Add it to .env.local"),
      );
      return;
    }

    // Script already in DOM (component remounted) but CollectJS not ready yet — poll for it
    const existing = document.querySelector("script[data-tokenization-key]");
    if (existing) {
      const start = Date.now();
      const poll = () => {
        if (window.CollectJS) {
          resolve();
          return;
        }
        if (Date.now() - start > 5000) {
          reject(
            new Error(
              "CollectJS timed out — check that your tokenization key is valid",
            ),
          );
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
      return;
    }

    const script = document.createElement("script");
    script.src = COLLECT_JS_URL;
    script.setAttribute("data-tokenization-key", tokenizationKey);
    script.setAttribute("data-variant", "inline");
    script.onload = () => {
      if (window.CollectJS) {
        resolve();
      } else {
        reject(
          new Error(                                            
            "CollectJS did not initialize — check that your tokenization key is valid",
          ),
        );
      }
    };
    script.onerror = () => reject(new Error("Failed to load Collect.js"));
    document.head.appendChild(script);
  });
}

const fieldMessages = {
  ccnumber: "Enter a valid card number",
  ccexp: "Enter a valid expiry date",
  cvv: "Enter a valid CVV",
};

export default function PaymentCardForm({
  control,
  tokenResolverRef,
  showAllErrors = false,
}) {
  const [fieldsReady, setFieldsReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({
    ccnumber: null,
    ccexp: null,
    cvv: null,
  });
  const [fieldTouched, setFieldTouched] = useState({
    ccnumber: false,
    ccexp: false,
    cvv: false,
  });
  const [cardholderTouched, setCardholderTouched] = useState(false);
  const initialized = useRef(false);
  const tokenKey = import.meta.env.VITE_NMI_TOKENIZATION_KEY;

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    loadCollectJs(tokenKey)
      .then(() => {
        window.CollectJS.configure({
          variant: "inline",
          styleSniffer: false,
          fields: {
            ccnumber: {
              selector: "#collect-ccnumber",
              placeholder: "1234 5678 9012 3456",
            },
            ccexp: { selector: "#collect-ccexp", placeholder: "MM / YY" },
            cvv: { selector: "#collect-cvv", placeholder: "CVV" },
          },
          customCss: {
            "font-size": "17px",
            color: "#1a1a1a",
            background: "transparent",
            border: "none",
            "border-radius": "0",
            outline: "none",
            "box-shadow": "none",
            "-webkit-appearance": "none",
            "-moz-appearance": "none",
            appearance: "none",
            width: "100%",
            height: "100%",
            padding: "0",
            margin: "0",
          },
          focusCss: {
            border: "none",
            outline: "0px",
            "outline-width": "0",
            "outline-style": "none",
            "box-shadow": "none",
          },
          invalidCss: {
            color: "#e74c3c",
            border: "none",
            "box-shadow": "none",
          },
          validCss: {
            color: "#1a1a1a",
            border: "none",
          },
          placeholderCss: {
            color: "#999",
          },
          fieldsAvailableCallback: () => setFieldsReady(true),
          validationCallback: (field, status, _message) => {
            setFieldErrors((prev) => ({
              ...prev,
              [field]: status ? null : (fieldMessages[field] ?? "Invalid"),
            }));
            setFieldTouched((prev) => ({ ...prev, [field]: true }));

            if (!status && tokenResolverRef.current) {
              const tid = tokenResolverRef.current._tid;
              if (tid) clearTimeout(tid);
              tokenResolverRef.current.reject(
                new Error("Please check your card details and try again."),
              );
              tokenResolverRef.current = null;
            }
          },
          callback: (response) => {
            if (!tokenResolverRef.current) return;
            const tid = tokenResolverRef.current._tid;
            if (tid) clearTimeout(tid);
            if (response.token) {
              tokenResolverRef.current.resolve({
                token: response.token,
                cardBrand: response.card?.type || null,
                cardLast4:
                  (response.card?.number || "").replace(/\D/g, "").slice(-4) ||
                  null,
              });
            } else {
              tokenResolverRef.current.reject(
                new Error(
                  "Card tokenization failed. Check your card details and try again.",
                ),
              );
            }
            tokenResolverRef.current = null;
          },
        });
      })
      .catch((err) => setLoadError(err.message));
  }, [tokenKey, tokenResolverRef]);

  return (
    <div>
      {loadError && (
        <p className="rf-help error">
          Payment fields failed to load: {loadError}
        </p>
      )}

      <div
        className="rf-field"
        style={!fieldsReady ? { opacity: 0.4, pointerEvents: "none" } : {}}
      >
        <label className="rf-label">
          Card number <span className="rf-req">*</span>
        </label>
        <div
          id="collect-ccnumber"
          className={`rf-input rf-collect-field ${fieldTouched.ccnumber && fieldErrors.ccnumber ? "error" : ""}`}
        />
        {fieldTouched.ccnumber && fieldErrors.ccnumber && (
          <p className="rf-help error">{fieldErrors.ccnumber}</p>
        )}
      </div>

      <div className="rf-field">
        <label className="rf-label">
          Cardholder name <span className="rf-req">*</span>
        </label>
        <Controller
          name="payment.cardholderName"
          control={control}
          render={({ field, fieldState }) => {
            const showErr =
              (cardholderTouched || showAllErrors) && fieldState.error?.message;
            return (
              <>
                <input
                  {...field}
                  onBlur={(e) => {
                    field.onBlur(e);
                    setCardholderTouched(true);
                  }}
                  type="text"
                  placeholder="Name on card"
                  autoComplete="cc-name"
                  className={`rf-input ${showErr ? "error" : ""}`}
                />
                {showErr && (
                  <p className="rf-help error">{fieldState.error.message}</p>
                )}
              </>
            );
          }}
        />
      </div>

      <div
        className="rf-field rf-row rf-row-2"
        style={!fieldsReady ? { opacity: 0.4, pointerEvents: "none" } : {}}
      >
        <div>
          <label className="rf-label">
            Expiry <span className="rf-req">*</span>
          </label>
          <div
            id="collect-ccexp"
            className={`rf-input rf-collect-field ${fieldTouched.ccexp && fieldErrors.ccexp ? "error" : ""}`}
          />
          {fieldTouched.ccexp && fieldErrors.ccexp && (
            <p className="rf-help error">{fieldErrors.ccexp}</p>
          )}
        </div>
        <div>
          <label className="rf-label">
            CVV <span className="rf-req">*</span>
          </label>
          <div
            id="collect-cvv"
            className={`rf-input rf-collect-field ${fieldTouched.cvv && fieldErrors.cvv ? "error" : ""}`}
          />
          {fieldTouched.cvv && fieldErrors.cvv && (
            <p className="rf-help error">{fieldErrors.cvv}</p>
          )}
        </div>
      </div>

      {!fieldsReady && !loadError && (
        <p className="rf-help" style={{ marginTop: 8 }}>
          Loading secure card fields…
        </p>
      )}
    </div>
  );
}
