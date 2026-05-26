import { useEffect, useRef } from "react";
import { Controller, useWatch } from "react-hook-form";
import {
  US_STATES,
  COUNTRIES,
  PROPERTY_TYPES,
  TAX_ID_TYPES,
  getStatesForCountry,
} from "../constants";
import { lookupPlaceForZip } from "../utils/zipValidation";
import SegmentedToggle from "./SegmentedToggle";

const EMPTY_SHIPPING = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  zip: "",  
  country: "United States",
};

function AddressBlock({ name, control, errors, setValue }) {
  const country = useWatch({ control, name: `${name}.country` });
  const zip = useWatch({ control, name: `${name}.zip` });
  const cityValue = useWatch({ control, name: `${name}.city` });
  const prevCountryRef = useRef(country);
  const states = getStatesForCountry(country);
  const e = errors?.[name] || {};

  // Track latest city value via ref so the autofill effect can read it
  // without re-firing on every keystroke in the city field.
  const cityRef = useRef(cityValue);
  useEffect(() => {
    cityRef.current = cityValue;
  }, [cityValue]);

  useEffect(() => {
    if (prevCountryRef.current === country) return;
    prevCountryRef.current = country;
    setValue(`${name}.state`, "", { shouldValidate: false });
    setValue(`${name}.zip`, "", { shouldValidate: false });
  }, [country, name, setValue]);

  // ZIP → city autofill. When the user pauses typing the ZIP, look up the
  // place via Zippopotam and fill the city field if it's still empty. We
  // never overwrite a user-entered city.
  useEffect(() => {
    if (!zip || !country) return;
    let cancelled = false;
    const tid = setTimeout(async () => {
      const result = await lookupPlaceForZip(zip, country);
      if (cancelled || !result?.city) return;
      if (!cityRef.current?.trim()) {
        setValue(`${name}.city`, result.city, { shouldValidate: true });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(tid);
    };
  }, [zip, country, name, setValue]);
  return (
    <>
      <div className="rf-field">
        <label className="rf-label">
          Street address <span className="rf-req">*</span>
        </label>
        <Controller
          name={`${name}.line1`}
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="123 Main Street"
              className={`rf-input ${e.line1 ? "error" : ""}`}
            />
          )}
        />
        {e.line1 && <p className="rf-help error">{e.line1.message}</p>}
      </div>

      <div className="rf-field">
        <label className="rf-label">
          Address Line 2 <span className="rf-opt">Optional</span>
        </label>
        <Controller
          name={`${name}.line2`}
          control={control}
          render={({ field }) => (
            <input
              {...field}
              type="text"
              placeholder="Suite 200"
              className="rf-input"
            />
          )}
        />
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">
            Country <span className="rf-req">*</span>
          </label>
          <Controller
            name={`${name}.country`}
            control={control}
            render={({ field }) => (
              <select
                {...field}
                className={`rf-select ${e.country ? "error" : ""}`}
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          />
          {e.country && <p className="rf-help error">{e.country.message}</p>}
        </div>
        <div>
          <label className="rf-label">
            State <span className="rf-req">*</span>
          </label>
          <Controller
            name={`${name}.state`}
            control={control}
            render={({ field }) =>
              states && states.length > 0 ? (
                <select
                  {...field}
                  className={`rf-select ${e.state ? "error" : ""}`}
                >
                  <option value="">Select</option>
                  {states.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...field}
                  type="text"
                  placeholder="State / Province"
                  className={`rf-input ${e.state ? "error" : ""}`}
                />
              )
            }
          />
          {e.state && <p className="rf-help error">{e.state.message}</p>}
        </div>
      </div>

      <div className="rf-field rf-row rf-row-2">
        <div>
          <label className="rf-label">
            ZIP code <span className="rf-req">*</span>
          </label>
          <Controller
            name={`${name}.zip`}
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="97201"
                maxLength={10}
                className={`rf-input ${e.zip ? "error" : ""}`}
              />
            )}
          />
          {e.zip && <p className="rf-help error">{e.zip.message}</p>}
        </div>

        <div>
          <label className="rf-label">
            City <span className="rf-req">*</span>
          </label>
          <Controller
            name={`${name}.city`}
            control={control}
            render={({ field }) => (
              <input
                {...field}
                type="text"
                placeholder="Portland"
                className={`rf-input ${e.city ? "error" : ""}`}
              />
            )}
          />
          {e.city && <p className="rf-help error">{e.city.message}</p>}
        </div>
      </div>
    </>
  );
}

export default function Step2AddressTax({
  control,
  errors,
  setValue,
  clearErrors,
}) {
  const sameAsBilling = useWatch({ control, name: "shippingSameAsBilling" });
  const resells = useWatch({ control, name: "resellsProducts" });
  const taxIdType = useWatch({ control, name: "tax.taxIdType" });

  const isFirstRender = useRef(true);

  // Clear shipping when toggle flips; skip on mount so back-navigation preserves entered address
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (sameAsBilling) {
      setValue("shippingAddress", null, { shouldValidate: false });
    } else {
      setValue("shippingAddress", EMPTY_SHIPPING, { shouldValidate: false });
      clearErrors("shippingAddress");
    }
  }, [sameAsBilling, setValue, clearErrors]);

  // Clear tax sub-field errors when the tax section is first revealed
  useEffect(() => {
    if (resells) clearErrors("tax");
  }, [resells, clearErrors]);

  return (
    <section className="rf-step">
      <div className="rf-save-banner">
        {/* <span className="rf-save-pulse" />
        Progress saved.  */}
      </div>

      <h1 className="rf-step-title">Where are we shipping?</h1>
      <p className="rf-step-subtitle">
        Your billing and shipping addresses, plus tax info if you resell.
      </p>

      <h3 className="rf-section-label" style={{ marginBottom: 14 }}>
        Billing address
      </h3>
      <AddressBlock
        name="billingAddress"
        control={control}
        errors={errors}
        setValue={setValue}
      />

      <div className="rf-toggle-row">
        <div>
          <strong>Shipping address same as billing</strong>
          <div className="desc">
            Toggle off if you need orders delivered elsewhere
          </div>
        </div>
        <Controller
          name="shippingSameAsBilling"
          control={control}
          render={({ field }) => (
            <SegmentedToggle
              value={field.value ? "yes" : "no"}
              onChange={(v) => field.onChange(v === "yes")}
              options={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
            />
          )}
        />
      </div>

      <div
        className={`rf-conditional ${sameAsBilling === false ? "open" : ""}`}
      >
        <div className="rf-conditional-inner">
          <h4 className="rf-conditional-heading">Shipping address</h4>
          {sameAsBilling === false && (
            <AddressBlock
              name="shippingAddress"
              control={control}
              errors={errors}
              setValue={setValue}
            />
          )}
        </div>
      </div>

      <div className="rf-field" style={{ marginTop: 18 }}>
        <label className="rf-label">
          Shipping address type <span className="rf-req">*</span>
          <span className="rf-hint">
            Helps couriers route deliveries correctly
          </span>
        </label>
        <Controller
          name="shippingPropertyType"
          control={control}
          render={({ field }) => (
            <select
              {...field}
              className={`rf-select ${errors.shippingPropertyType ? "error" : ""}`}
            >
              {PROPERTY_TYPES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        />
        {errors.shippingPropertyType && (
          <p className="rf-help error">{errors.shippingPropertyType.message}</p>
        )}
      </div>

      <div className="rf-divider">
        <h2 className="rf-section-label">Tax status</h2>
        <p className="rf-section-hint">
          Only applies if you're reselling products to customers.
        </p>
      </div>

      <div className="rf-toggle-row">
        <div>
          <strong>Will you resell our products?</strong>
          <div className="desc">
            Choose "No" if you use products in-practice only
          </div>
        </div>
        <Controller
          name="resellsProducts"
          control={control}
          render={({ field }) => (
            <SegmentedToggle
              value={field.value ? "yes" : "no"}
              onChange={(v) => field.onChange(v === "yes")}
              options={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
            />
          )}
        />
      </div>

      <div className={`rf-conditional ${resells ? "open" : ""}`}>
        <div className="rf-conditional-inner">
          <div className="rf-trust">
            <svg
              className="rf-icon-svg"
              viewBox="0 0 24 24"
              style={{ width: 16, height: 16 }}
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>
              Your tax ID is encrypted and used only for resale certificate
              verification.
            </span>
          </div>

          <div className="rf-field">
            <label className="rf-label">
              Tax ID type <span className="rf-req">*</span>
            </label>
            <Controller
              name="tax.taxIdType"
              control={control}
              defaultValue="ein"
              render={({ field }) => (
                <div style={{ marginBottom: 10 }}>
                  <SegmentedToggle
                    value={field.value || "ein"}
                    onChange={field.onChange}
                    options={[
                      { value: "ein", label: "EIN" },
                      { value: "ssn", label: "SSN" },
                    ]}
                  />
                </div>
              )}
            />
            <Controller
              name="tax.taxId"
              control={control}
              defaultValue=""
              render={({ field }) => (
                <input
                  {...field}
                  type="text"
                  placeholder={
                    taxIdType === "ssn" ? "XXX-XX-XXXX" : "XX-XXXXXXX"
                  }
                  className={`rf-input ${errors.tax?.taxId ? "error" : ""}`}
                />
              )}
            />
            {errors.tax?.taxId ? (
              <p className="rf-help error">{errors.tax.taxId.message}</p>
            ) : (
              <p className="rf-help">
                {taxIdType === "ssn"
                  ? "Only required if EIN is not applicable"
                  : "9-digit Employer Identification Number"}
              </p>
            )}
          </div>

          <div className="rf-field rf-row rf-row-2">
            <div>
              <label className="rf-label">
                Sales tax permit # <span className="rf-opt">Optional</span>
              </label>
              <Controller
                name="tax.salesPermit"
                control={control}
                defaultValue=""
                render={({ field }) => (
                  <input
                    {...field}
                    type="text"
                    placeholder="Permit # or date applied"
                    className="rf-input"
                  />
                )}
              />
              <p className="rf-help">
                Or out-of-state reseller's registration number / date applied
                for permit.
              </p>
            </div>
            <div>
              <label className="rf-label">
                Exempt state <span className="rf-req">*</span>
              </label>
              <Controller
                name="tax.exemptState"
                control={control}
                defaultValue=""
                render={({ field }) => (
                  <select
                    {...field}
                    className={`rf-select ${errors.tax?.exemptState ? "error" : ""}`}
                  >
                    <option value="">Select</option>
                    {US_STATES.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              />
              {errors.tax?.exemptState && (
                <p className="rf-help error">
                  {errors.tax.exemptState.message}
                </p>
              )}
            </div>
          </div>

          <div className="rf-field">
            <label className="rf-label">
              Description of items to be purchased on the attached order or
              invoice:
              <span className="rf-req">*</span>
            </label>
            <Controller
              name="tax.itemsToResell"
              control={control}
              defaultValue=""
              render={({ field }) => (
                <textarea
                  {...field}
                  placeholder="e.g., Herbal supplements, homeopathic remedies, essential oils"
                  className={`rf-textarea ${errors.tax?.itemsToResell ? "error" : ""}`}
                />
              )}
            />
            {errors.tax?.itemsToResell ? (
              <p className="rf-help error">
                {errors.tax.itemsToResell.message}
              </p>
            ) : (
              <p className="rf-help">
                Specific products you plan to purchase from us for resale.
              </p>
            )}
          </div>

          <div className="rf-field">
            <label className="rf-label">
              Description of type of business activity generally engaged in or
              type of items sold by the purchaser:
              <span className="rf-req">*</span>
            </label>
            <Controller
              name="tax.businessActivity"
              control={control}
              defaultValue=""
              render={({ field }) => (
                <textarea
                  {...field}
                  placeholder="e.g., Holistic wellness clinic offering nutrition counseling and supplement sales"
                  className={`rf-textarea ${errors.tax?.businessActivity ? "error" : ""}`}
                />
              )}
            />
            {errors.tax?.businessActivity ? (
              <p className="rf-help error">
                {errors.tax.businessActivity.message}
              </p>
            ) : (
              <p className="rf-help">
                Brief description of your overall business and what you sell to
                customers.
              </p>
            )}
          </div>

          <div className="rf-seller-info">
            <div className="rf-seller-label">
              I, the purchaser named above, claim the right to make a
              non-taxable purchase for resale of the taxable items described
              below or on the attached order, or invoice:
            </div>
            <div className="rf-seller-content">
              <strong>Natural Solutions Wholesale, LLC</strong>
              <br />
              303 N. Washington St., Sylvester, GA 31791
            </div>
          </div>

          <details className="rf-resale-terms">
            <summary>
              <span style={{ fontWeight: 500 }}>
                View resale certificate terms
              </span>
              <svg
                className="chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </summary>
            <div className="rf-resale-content">
              <p>
                The taxable items described above, or on the attached order or
                invoice, will be resold, rented, or leased by me within the
                geographical limits of the United States of America, its
                territories and possessions, or within the geographical limits
                of the United Mexican States, in their present form or attached
                to other taxable items to be sold
              </p>
              <p>
                I understand that if I make any use of the items other than
                retention, demonstration or display while holding them for sale,
                lease or rental, I must pay sales tax on the items at the time
                of use based upon either the purchase price or the fair market
                rental value for the period of time used.
              </p>
              <p>
                I understand that it is a criminal offense to give a resale
                certificate to the seller for taxable items that I know, at the
                time of purchase, are purchased for use rather than for the
                purpose of resale, lease, or rental and, depending on the amount
                of tax evaded, the offense may range from a Class C misdemeanor
                to a felony of the second degree.
              </p>
              <p className="rf-resale-acknowledge">
                You'll acknowledge these terms with your e-signature on the
                final step.
              </p>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
