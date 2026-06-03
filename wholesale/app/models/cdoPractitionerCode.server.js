// MIRROR schema of ns-retail/app/models/cdoPractitionerCode.server.js
// Both apps connect to the same MongoDB and write to the same
// `cdo_practitioner_codes` collection. Mongoose requires the model to
// be registered in the app where it's used, so this file is the
// wholesale-side copy.
//
// MAINTENANCE RULE: When you change the shape of cdo_practitioner_codes
// (add/remove fields, change indexes), update BOTH this file AND
// ns-retail/app/models/cdoPractitionerCode.server.js. They MUST stay
// in sync — Mongoose `strict: true` will silently drop unknown fields
// on $set in whichever app has the stale schema.

import mongoose from "mongoose";

const cdoPractitionerCodeSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, required: true, index: true },
    practitionerEmail: { type: String, lowercase: true, index: true },
    practitionerName: String,

    // Lowercase, alphanumeric + underscore. Locked format:
    // `<firstname>_<8-char-hex>` (e.g. `john_a3f1c8e2`). Unique per shop.
    code: { type: String, required: true, lowercase: true, trim: true },

    isPrimary: { type: Boolean, default: false, index: true },

    discountPercent: { type: Number, default: 0 },
    commissionRate: { type: Number, default: null },

    status: {
      type: String,
      enum: ["active", "paused", "archived"],
      default: "active",
      index: true,
    },

    note: String,

    createdBy: String,
    updatedBy: String,
  },
  { collection: "cdo_practitioner_codes", timestamps: true, strict: true },
);

cdoPractitionerCodeSchema.index({ shop: 1, code: 1 }, { unique: true });

cdoPractitionerCodeSchema.index(
  { practitionerId: 1, isPrimary: 1 },
  {
    unique: true,
    partialFilterExpression: { isPrimary: true },
  },
);

export default mongoose.models.CdoPractitionerCode ||
  mongoose.model("CdoPractitionerCode", cdoPractitionerCodeSchema);
