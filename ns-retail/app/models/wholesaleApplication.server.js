// Read-only mirror of the wholesale workspace's wholesale_applications
// collection. ns-retail only needs a subset of fields for the CDO
// Practitioners page; the canonical schema is owned by wholesale/
// (see wholesale/app/models/wholesaleApplication.server.js).
//
// `strict: false` lets us read documents that contain fields not
// declared below — safer when the wholesale schema evolves.

import mongoose from "mongoose";

const taxSchema = new mongoose.Schema(
  {
    itemsToResell: String,
  },
  { _id: false, strict: false },
);

const wholesaleApplicationSchema = new mongoose.Schema(
  {
    shop: String,
    firstName: String,
    lastName: String,
    email: String,
    businessName: String,
    phone: String,
    submittedAt: Date,
    customerId: String,
    status: String,
    tax: { type: taxSchema, default: null },
  },
  { collection: "wholesale_applications", strict: false, timestamps: true },
);

export default mongoose.models.WholesaleApplication ||
  mongoose.model("WholesaleApplication", wholesaleApplicationSchema);
