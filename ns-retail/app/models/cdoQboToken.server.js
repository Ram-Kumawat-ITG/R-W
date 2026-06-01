// Singleton OAuth token document for the CDO Program's OWN QuickBooks
// Online account — deliberately separate from the wholesale workspace's
// `qbo_tokens` collection so the two QBO realms never share state.
//
// Intuit rotates the refresh token on every access-token refresh, so we
// persist the latest pair atomically (see services/qbo/qbo.apis.js).

import mongoose from "mongoose";

const cdoQboTokenSchema = new mongoose.Schema(
  {
    realmId: { type: String, required: true, unique: true, index: true },
    accessToken: { type: String, required: true },
    accessTokenExpiresAt: { type: Date, required: true },
    refreshToken: { type: String, required: true },
    refreshTokenExpiresAt: { type: Date },
    tokenType: { type: String, default: "bearer" },
  },
  { collection: "cdo_qbo_tokens", timestamps: true },
);

export default mongoose.models.CdoQboToken ||
  mongoose.model("CdoQboToken", cdoQboTokenSchema);
