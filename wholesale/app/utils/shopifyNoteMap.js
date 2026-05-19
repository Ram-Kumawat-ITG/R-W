// Source of truth for translating our internal Mongo keys → the exact display
// strings used in the Shopify customer "note" field. Typos in the spec are
// preserved on purpose (Other_Credientials, Residental-Commercial) — see the
// implementation spec.

export const SAME_AS_BILLING = {
  true: "Yes_Same_As_Billing",
  false: "No_Same_As_Billing",
}

export const PROPERTY_TYPE_KEY = "Residental-Commercial"

// Each credential: how it maps from our internal id → the credential note key,
// and (optionally) the note key for its primary file URL.
export const CREDENTIAL_MAP = [
  { id: "acupuncturist",          credKey: "Acupuncturist",                 fileKey: "Acupuncturist-License",        fileIndex: 0 },
  { id: "bio-energetic",          credKey: "Bio-Energetic_Practitioner" },
  { id: "chiropractor",           credKey: "Chiropractor",                  fileKey: "Chiropractor-License",         fileIndex: 0 },
  { id: "health-coach",           credKey: "HealthCoach",                   fileKey: "HealthCoach-License",          fileIndex: 0 },
  { id: "medical",                credKey: "LicensedMedicalProfessional",   fileKey: "LicensedMedicalProfessional-License", fileIndex: 1 },
  { id: "massage",                credKey: "Licensed_Massage_Therapist",    fileKey: "Licensed_Massage_Therapist-License", fileIndex: 0 },
  { id: "naturopath-doctor",      credKey: "NaturopathicDoctor",            fileKey: "NaturopathicDoctor-License",   fileIndex: 0 },
  { id: "nutritionist",           credKey: "Nutritionist",                  fileKey: "Nutritionist-License",         fileIndex: 0 },
  { id: "qest4",                  credKey: "QEST4_User" },
  { id: "reflexologist",          credKey: "Reflexologist",                 fileKey: "Reflexologist-License",        fileIndex: 0 },
  { id: "traditional-naturopath", credKey: "Traditional-Naturopath",        fileKey: "Traditional-Naturopath-License", fileIndex: 0 },
  { id: "veterinarian",           credKey: "Veterinarian",                  fileKey: "Veterinarian-License",         fileIndex: 0 },
  { id: "other",                  credKey: "Other_Credientials",            fileKey: "Other-License",                fileIndex: 0 },
]

export const REFERRAL_MAP = [
  { id: "ihha",         key: "Referred-IHHA" },
  { id: "qest4-ref",    key: "Referred-Qest" },
  { id: "practitioner", key: "Referred-Practitioner" },
  { id: "other-ref",    key: "Referred-Other" },
  { id: "none",         key: "Referred-None" },
]
