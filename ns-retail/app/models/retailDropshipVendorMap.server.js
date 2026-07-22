// Durable mapping for the ONE QBO Vendor the retail dropship bills post to
// (the "Natural Solution Wholesale" supplier). Lets us create/adopt that
// vendor exactly once and reuse its id across every future bill + process
// restart — instead of re-querying QBO each boot or depending on a hardcoded
// QBO_RETAIL_DROPSHIP_VENDOR_ID env var.
//
// There is exactly one dropship supplier per retail QBO realm, so this is a
// singleton row keyed by a constant `key`. Mirrors the CdoVendorMap pattern
// (cdo_qbo_vendors) used for per-practitioner payout vendors.

import mongoose from "mongoose";

// Constant key for the singleton row (one dropship supplier vendor per realm).
export const DROPSHIP_VENDOR_KEY = "dropship-supplier";

const retailDropshipVendorMapSchema = new mongoose.Schema(
  {
    // Singleton discriminator — always DROPSHIP_VENDOR_KEY today; a field
    // (not a hardcoded _id) so the unique index reads clearly and leaves room
    // for a future multi-supplier variant.
    key: { type: String, required: true, unique: true, default: DROPSHIP_VENDOR_KEY },
    qboVendorId: { type: String, required: true },
    displayName: String,
    email: { type: String, lowercase: true },
    // How the id was obtained: 'env' (QBO_RETAIL_DROPSHIP_VENDOR_ID override),
    // 'adopted' (matched an existing QBO vendor by email/name), or 'created'.
    resolvedVia: { type: String, enum: ["env", "adopted", "created"] },
    syncedAt: { type: Date, default: Date.now },
  },
  { collection: "retail_qbo_dropship_vendor", timestamps: true },
);

export default mongoose.models.RetailDropshipVendorMap ||
  mongoose.model("RetailDropshipVendorMap", retailDropshipVendorMapSchema);
