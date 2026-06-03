// Maps a CDO practitioner to their QuickBooks Online Vendor record so we
// create each vendor exactly once and reuse it across payouts.
//
// The practitioner lives in wholesale_applications (a read-only mirror
// owned by the wholesale workspace), so we can't stamp the QBO vendor id
// there — this collection is the CDO-owned mapping instead.
//
// Keyed by (practitionerId, practitionerSource) to mirror how referral
// codes identify their owning practitioner (see cdoPractitionerCode).

import mongoose from "mongoose";

const cdoVendorMapSchema = new mongoose.Schema(
  {
    practitionerId: { type: String, required: true, index: true },
    practitionerSource: {
      type: String,
      enum: ["cdo", "wholesale"],
      default: "wholesale",
    },
    qboVendorId: { type: String, required: true },
    displayName: String,
    email: { type: String, lowercase: true },
    syncedAt: { type: Date, default: Date.now },
  },
  { collection: "cdo_qbo_vendors", timestamps: true },
);

// One vendor mapping per practitioner.
cdoVendorMapSchema.index(
  { practitionerId: 1, practitionerSource: 1 },
  { unique: true },
);

export default mongoose.models.CdoVendorMap ||
  mongoose.model("CdoVendorMap", cdoVendorMapSchema);
