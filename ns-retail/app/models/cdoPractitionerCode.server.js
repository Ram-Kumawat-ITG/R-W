// Source catalogue of valid practitioner referral codes. One doc per code;
// a practitioner may hold many. Distinct from `cdo_referrals` which tracks
// each USE of a code.
//
// practitionerSource picks which collection holds the owning record:
// "wholesale" → wholesale_applications, "cdo" → cdo_applications.
//
// Discount + commission updates apply forward-only — existing cdo_orders /
// cdo_commissions are immutable history.

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

    code: { type: String, required: true, lowercase: true, trim: true },

    isPrimary: { type: Boolean, default: false, index: true },

    // Fraction format (0.10 = 10%), matching cdo_settings.defaultCommissionRate.
    discountPercent: { type: Number, default: 0 },

    // Falls back to cdo_settings.defaultCommissionRate when null.
    commissionRate: { type: Number, default: null },

    // Populated after the matching Shopify discount object is created on
    // the retail store. shopifyDiscountUrl is the shareable storefront URL
    // (https://<retail-shop>/discount/<code>) — visiting auto-applies the
    // code at checkout. Both stay null if discount creation failed.
    shopifyDiscountId: { type: String, default: null },
    shopifyDiscountUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ["active", "paused", "archived"],
      default: "active",
      index: true,
    },

    note: String,

    // Provenance — set when this record was created by a bulk data migration
    // (e.g. the GoAffPro import) rather than the live pipeline / portal.
    // `migrationSource` gives a uniform, indexed filter across every CDO
    // collection ({ migrationSource: "goaffpro" }); `migrationRunId` ties the
    // record back to its cdo_migration_runs audit entry. Both null for
    // organically-created records.
    migrationSource: { type: String, default: null, index: true },
    migrationRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CdoMigrationRun",
      default: null,
      index: true,
    },

    createdBy: String,
    updatedBy: String,
  },
  { collection: "cdo_practitioner_codes", timestamps: true, strict: true },
);

cdoPractitionerCodeSchema.index({ shop: 1, code: 1 }, { unique: true });

// At most one primary per practitioner.
cdoPractitionerCodeSchema.index(
  { practitionerId: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } },
);

export default mongoose.models.CdoPractitionerCode ||
  mongoose.model("CdoPractitionerCode", cdoPractitionerCodeSchema);
