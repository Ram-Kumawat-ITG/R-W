import mongoose from 'mongoose'

// Maps a Shopify customer (by id + email) to the matching records in
// QBO and NMI. Lets us look up downstream IDs in O(1) rather than
// hitting each provider's search API on every order.
const customerMapSchema = new mongoose.Schema(
  {
    shop: { type: String, index: true },

    shopifyCustomerId: { type: String, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    qboCustomerId: { type: String, index: true },
    nmiCustomerVaultId: { type: String, index: true },

    // Snapshot used for matching/recreating in either system. Kept here
    // (not just referenced from Shopify) so jobs running async don't
    // need a fresh admin API call.
    profile: {
      firstName: String,
      lastName: String,
      companyName: String,
      phone: String,
      billingAddress: mongoose.Schema.Types.Mixed,
      shippingAddress: mongoose.Schema.Types.Mixed,
    },

    lastSyncedAt: Date,
  },
  { collection: 'customer_maps', timestamps: true, strict: true },
)

customerMapSchema.index({ shop: 1, email: 1 }, { unique: true })

export default mongoose.models.CustomerMap || mongoose.model('CustomerMap', customerMapSchema)
