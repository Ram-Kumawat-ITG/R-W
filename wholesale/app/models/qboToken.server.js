import mongoose from 'mongoose'

// Singleton document storing the current QBO OAuth state for a realm.
// Intuit rotates the refresh token on every access-token refresh, so we
// must persist the latest pair atomically.
const qboTokenSchema = new mongoose.Schema(
  {
    realmId: { type: String, required: true, unique: true, index: true },
    accessToken: { type: String, required: true },
    accessTokenExpiresAt: { type: Date, required: true },
    refreshToken: { type: String, required: true },
    refreshTokenExpiresAt: { type: Date },
    tokenType: { type: String, default: 'bearer' },
  },
  { collection: 'qbo_tokens', timestamps: true },
)

export default mongoose.models.QboToken || mongoose.model('QboToken', qboTokenSchema)
