// CDO practitioner referral code — one document per CODE, owned by one
// practitioner. A practitioner can hold many codes; one is flagged as
// "primary" and is used as the default when the storefront / admin
// generate a referral link.
//
// Distinct from `cdo_referrals` (which tracks a prospect's USE of a
// code — one row per referred shopper). This collection is the SOURCE
// catalogue of valid codes.
//
// Discount + commission live on the code itself so different codes for
// the same practitioner can carry different terms (e.g. a "VIP15" code
// for 15% off vs a "FAMILY10" code for 10% off, both feeding the same
// practitioner's commission ledger). When discount/commission are
// updated, the change applies ONLY to orders placed AFTER the update —
// existing cdo_orders / cdo_commissions are immutable history.
//
// Practitioner identification:
//   - `practitionerId` is the owning application document `_id` (the same
//     string the CDO Customers list uses as a row id).
//   - `practitionerSource` says WHICH collection that id lives in:
//     "wholesale" → wholesale_applications (the default — practitioners
//     live here) or "cdo" → cdo_applications. This lets a referral code
//     map back to an application record without a separate user
//     collection. Customers (cdo_applications) consume these codes; they
//     don't own them.
//   - `practitionerEmail` is denormalized for fast lookups + matches
//     the rest of the cdo_* collections' field naming.

import mongoose from "mongoose";

const cdoPractitionerCodeSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, required: true, index: true },
    practitionerSource: {
      type: String,
      enum: ["cdo", "wholesale"],
      default: "wholesale",
      index: true,
    },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    // The code string itself — lowercase, alphanumeric + underscore.
    // Locked format from the CDO roadmap is `<firstname>_<8-char-hex>`,
    // e.g. `john_a3f1c8e2`. Unique per shop. Storefront / Shopify
    // discount engines match case-insensitively so display case is
    // user-friendly but storage is canonical lowercase.
    code: { type: String, required: true, lowercase: true, trim: true },

    // Exactly one code per practitioner should be `isPrimary: true`.
    // Enforced by a partial unique index below + the setPrimary helper
    // in cdo.service.js which clears the flag on siblings before
    // setting it on the chosen code. Storefront / admin code-pickers
    // resolve "the practitioner's code" via this flag.
    isPrimary: { type: Boolean, default: false, index: true },

    // Per-code discount applied at checkout. Stored as a fraction
    // (0.10 = 10%) so it's consistent with the existing
    // defaultCommissionRate in cdo_settings. Admin UI converts to /
    // from the human "%" representation.
    discountPercent: { type: Number, default: 0 },

    // Per-code commission rate paid to the practitioner. Falls back
    // to cdo_settings.defaultCommissionRate when unset. Same fraction
    // format as discountPercent.
    commissionRate: { type: Number, default: null },

    status: {
      type: String,
      enum: ["active", "paused", "archived"],
      default: "active",
      index: true,
    },

    // Optional human note — admins can record why a code exists, who
    // requested it, etc. Surfaced on the practitioner detail page.
    note: String,

    // Audit — who last touched this code. `createdBy` is set once at
    // insert; `updatedBy` is overwritten on every save.
    createdBy: String,
    updatedBy: String,
  },
  { collection: "cdo_practitioner_codes", timestamps: true, strict: true },
);

// One code value per shop. Enforced at the DB level so two practitioners
// can't claim the same code; admin-side helpers should detect the dup
// pre-write and surface a friendlier error.
cdoPractitionerCodeSchema.index({ shop: 1, code: 1 }, { unique: true });

// At most one primary code per practitioner. Partial filter so
// non-primary documents don't trip the unique constraint when no
// `isPrimary: true` doc exists yet.
cdoPractitionerCodeSchema.index(
  { practitionerId: 1, isPrimary: 1 },
  {
    unique: true,
    partialFilterExpression: { isPrimary: true },
  },
);

export default mongoose.models.CdoPractitionerCode ||
  mongoose.model("CdoPractitionerCode", cdoPractitionerCodeSchema);
