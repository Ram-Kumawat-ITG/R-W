import * as yup from "yup";
import {
  MAX_FILE_SIZE,
  ACCEPTED_MIME_TYPES,
  CREDENTIALS,  
  REFERRALS,
} from "../constants";

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
    .min(2, "Too short")
    .matches(/^[A-Za-z\s'-]+$/, "Letters only"),
  lastName: yup.string().trim().required("Required").min(2, "Too short"),
  email: yup
    .string()
    .trim()
    .required("Required")
    .email("Enter a valid email"),
  phone: yup
    .string()
    .trim()
    .required("Required")
    .matches(
      /^\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$/,
      "Enter a valid phone number (e.g. (555) 123-4567)",
    ),
  password: yup
    .string()
    .trim()
    .required("Required")
    .min(8, "At least 8 characters")
    .matches(/[A-Za-z]/, "Must include a letter")
    .matches(/\d/, "Must include a number"),
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
  "password",
  "businessName",
  "credentials",
  "referrals",
];
