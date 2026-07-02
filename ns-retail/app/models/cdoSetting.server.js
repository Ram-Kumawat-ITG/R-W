// CDO Program configuration — a single settings document per shop.
// `singletonKey` carries a unique index so the upsert can only ever
// maintain one config row. Owned by the CDO Program module.

import mongoose from "mongoose";

// One configured commission rate for a Shopify product vendor. `commissionPercent`
// is a FRACTION (0.10 = 10%), matching defaultCommissionRate / discountPercent.
// Commission is vendor-driven: a product whose vendor has NO entry here earns 0%.
const vendorCommissionSchema = new mongoose.Schema(
  {
    vendor: { type: String, required: true },
    commissionPercent: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: null },
  },
  { _id: false },
);

const cdoSettingSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },
    singletonKey: { type: String, default: "cdo-program", unique: true },

    programName: { type: String, default: "CDO Program" },
    defaultCommissionRate: { type: Number, default: 0.1 },
    currency: { type: String, default: "USD" },

    payoutSchedule: {
      type: String,
      enum: ["weekly", "biweekly", "monthly"],
      default: "monthly",
    },
    minimumPayoutAmount: { type: Number, default: 50 },
    autoApproveCommissions: { type: Boolean, default: false },
    cookieWindowDays: { type: Number, default: 30 },

    // ── Per-vendor commission configuration ──────────────────────────
    // Commission is computed per order line from the line's product vendor:
    // lineCommission = lineRevenue × vendorCommissions[vendor] (0 if the vendor
    // isn't listed). `commissionConfigVersion` is bumped on every change and
    // snapshotted onto each order at ingest, so edits apply only to FUTURE
    // orders — existing orders/commissions are immutable. Change history lives
    // in cdo_commission_config_history.
    vendorCommissions: { type: [vendorCommissionSchema], default: [] },
    commissionConfigVersion: { type: Number, default: 1 },

    // ── Tier-specific business rules (future-proof extension hook) ────
    // Optional, per-discount-tier rules evaluated at validation time by
    // cdo.service.evaluateTierRules (called from validateReferralCode). Empty
    // = today's behavior: every active code is equally valid. A rule lets the
    // program later express e.g. "30%+ codes are first-order only" or "10%
    // codes are evergreen" by adding DATA here + a small evaluator — without
    // rewriting the checkout-validation path. `strict:false` on the subdoc so
    // new rule kinds need no migration; unknown kinds fail-open (ignored).
    tierRules: {
      type: [
        new mongoose.Schema(
          {
            // Discount fraction this rule targets (0.30 = 30%); null = all tiers.
            discountPercent: { type: Number, default: null },
            kind: { type: String, default: null }, // e.g. "first_order_only"
            enabled: { type: Boolean, default: true },
            note: { type: String, default: null },
          },
          { _id: false, strict: false },
        ),
      ],
      default: [],
    },
  },
  { collection: "cdo_settings", timestamps: true, strict: true },
);

export default mongoose.models.CdoSetting ||
  mongoose.model("CdoSetting", cdoSettingSchema);
