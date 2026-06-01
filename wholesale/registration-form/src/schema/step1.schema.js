import * as yup from "yup";
import {
  MAX_FILE_SIZE,
  ACCEPTED_MIME_TYPES,
  CREDENTIALS,
  REFERRALS,
} from "../constants";

const NAME_REGEX = /^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/;
const PHONE_REGEX = /^\+?[0-9]+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fileWhenSelected = (message = "File is required") =>
  yup.mixed().when("selected", {
    is: true,
    then: (s) =>
      s
        .required(message)
        .test(
          "fileSize",
          "File must be under 20MB",
          (f) => !f || f.size <= MAX_FILE_SIZE,
        )
        .test(
          "fileType",
          "Allowed: PDF, JPG, PNG",
          (f) => !f || ACCEPTED_MIME_TYPES.includes(f.type),
        ),
    otherwise: (s) => s.nullable().notRequired(),
  });

const reqWhenSelected = (message = "Required") =>
  yup.string().when("selected", {
    is: true,
    then: (s) => s.trim().required(message),
    otherwise: (s) => s.notRequired(),
  });

const credentialShape = {};
CREDENTIALS.forEach((cred) => {
  const fields = { selected: yup.boolean() };
  cred.docs.forEach((doc, i) => {
    if (doc.type === "file") {
      fields[`file${i}`] = fileWhenSelected(`${doc.label} is required`);
    } else if (doc.type === "text" || doc.type === "select") {
      fields[doc.key] = reqWhenSelected(`${doc.label} is required`);
    }
  });
  credentialShape[cred.id] = yup.object(fields);
});

const referralShape = {};
REFERRALS.forEach((ref) => {
  if (ref.exclusive) {
    referralShape[ref.id] = yup.object({ selected: yup.boolean() });
  } else if (ref.field) {
    referralShape[ref.id] = yup.object({
      selected: yup.boolean(),
      value: reqWhenSelected(`${ref.name} detail is required`),
    });
  } else {
    referralShape[ref.id] = yup.object({ selected: yup.boolean() });
  }
});

export const step1Schema = yup.object({
  firstName: yup
    .string()
    .trim()
    .required("Required")
    .min(3, "Too short")
    .matches(
      NAME_REGEX,
      "Only letters, spaces, hyphens, and apostrophes allowed",
    ),
  lastName: yup
    .string()
    .trim()
    .required("Required")
    .min(3, "Too short")
    .matches(
      NAME_REGEX,
      "Only letters, spaces, hyphens, and apostrophes allowed",
    ),
  email: yup
    .string()
    .trim()
    .required("Required")
    .matches(EMAIL_REGEX, "Enter a valid email"),
  phone: yup
    .string()
    .trim()
    .required("Required")
    .matches(
      PHONE_REGEX,
      "Only digits and an optional '+' at the start (e.g., +15146669999)",
    )
    .test(
      "needs-country-code",
      "Phone must include country code (e.g., +15146669999 for US, +919887484997 for India)",
      (val) => {
        if (!val) return false;
        const digits = String(val).replace(/\D/g, "");
        // Require >=11 digits so country code is always included.
        // 11 = 1 country code + 10 number (NANP); up to 15 per E.164 spec.
        return digits.length >= 11 && digits.length <= 15;
      },
    ),

  // password: yup
  //   .string()
  //   .trim()
  //   .required("Required")
  //   .min(8, "At least 8 characters")
  //   .matches(/[A-Za-z]/, "Must include a letter")
  //   .matches(/\d/, "Must include a number"),
  businessName: yup.string().trim().notRequired(),
  credentials: yup
    .object(credentialShape)
    .test("one-selected", "Select at least one credential", (c) =>
      c ? Object.values(c).some((x) => x && x.selected === true) : false,
    ),
  referrals: yup
    .object(referralShape)
    .test("one-selected", "Select at least one referral source", (r) =>
      r ? Object.values(r).some((x) => x && x.selected === true) : false,
    ),
});

export const step1Fields = [
  "firstName",
  "lastName",
  "email",
  "phone",
  // "password",
  "businessName",
  "credentials",
  "referrals",
];
