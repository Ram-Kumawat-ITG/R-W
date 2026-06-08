// READ-ONLY MIRROR of the `cdo_payouts` collection owned by ns-retail.
//
// The wholesale app only READS this collection (Practitioner Portal
// payout history). ns-retail is the source of truth and the only writer.
// `strict: false` keeps unknown ns-retail fields readable. Do NOT write.

import mongoose from "mongoose";

const cdoPayoutSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    practitionerId: { type: String, index: true },
    practitionerSource: String,
    practitionerEmail: String,
    practitionerName: String,

    amount: Number,
    currency: String,
    method: String, // e.g. 'ach'
    status: { type: String, index: true }, // e.g. 'paid'

    reference: String,
    qboVendorId: String,
    qboBillId: String,
    qboBillPaymentId: String,

    commissionIds: [mongoose.Schema.Types.Mixed],

    approvedBy: String,
    approvedAt: Date,
    rejectedBy: String,
    rejectedAt: Date,
    rejectionReason: String,
    lastError: String,

    periodStart: Date,
    periodEnd: Date,
    paidAt: Date,
  },
  { collection: "cdo_payouts", timestamps: true, strict: false },
);

export default mongoose.models.CdoPayout ||
  mongoose.model("CdoPayout", cdoPayoutSchema);
