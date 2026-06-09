import * as yup from "yup";

// IRS Form W-9 — fields not already collected in Steps 1/2.
//
// Reused from earlier steps (NOT re-validated here):
//   legalName        ← derived from Step 1 firstName + lastName at submit
//                       (Step 4 UI shows an editable override stored as w9.legalName)
//   businessName     ← Step 1
//   address          ← Step 2 billingAddress.*
//   TIN (SSN/EIN)    ← Step 2 tax.taxIdType + tax.taxId
//
// New on Step 4:
//   w9.legalName             — editable, pre-filled from Step 1 names
//   w9.taxClassification     — required; one of 7 IRS classifications
//   w9.llcClassification     — required only when taxClassification = 'llc'
//   w9.otherClassification   — required only when taxClassification = 'other'
//   w9.exemptPayeeCode       — optional
//   w9.fatcaCode             — optional
//   w9.signature             — separate from Step 3 terms signature; carries the
//                              IRS perjury certification

const TAX_CLASSIFICATIONS = [
  "individual",
  "c_corp",
  "s_corp",
  "partnership",
  "trust_estate",
  "llc",
  "other",
];

export const step4Schema = yup.object({
  w9: yup.object({
    legalName: yup
      .string()
      .trim()
      .required("Required")
      .min(2, "Too short"),

    taxClassification: yup
      .string()
      .required("Select a tax classification")
      .oneOf(TAX_CLASSIFICATIONS, "Invalid value"),

    llcClassification: yup.string().when("taxClassification", {
      is: "llc",
      then: (s) =>
        s
          .required("Required for LLC")
          .oneOf(["C", "S", "P"], "Select C, S, or P"),
      otherwise: (s) => s.notRequired(),
    }),

    otherClassification: yup.string().when("taxClassification", {
      is: "other",
      then: (s) => s.trim().required("Describe your classification"),
      otherwise: (s) => s.notRequired(),
    }),

    exemptPayeeCode: yup.string().trim().notRequired(),
    fatcaCode: yup.string().trim().notRequired(),

    signature: yup
      .object({ drawn: yup.mixed().nullable() })
      .test(
        "w9-signature-present",
        "Please sign the W-9 certification before continuing",
        (s) => Boolean(s?.drawn),
      ),
  }),
});

export const step4Fields = ["w9"];
