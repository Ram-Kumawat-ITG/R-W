// MongoDB connection to the wholesale workspace's database.
//
// ns-retail reads from the wholesale_applications collection that
// wholesale/ owns — same MONGODB_URI as the wholesale app's .env.
//
// Cached on `global.mongooseConn` so dev hot-reload shares a single
// connection instead of pooling per import.

import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error(
    "Please define MONGODB_URI in ns-retail/.env — point it at the wholesale workspace's MongoDB so the CDO Practitioners page can read wholesale_applications.",
  );
}

let cached = global.mongooseConn;

if (!cached) {
  cached = global.mongooseConn = { conn: null, promise: null };
}

export default async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, { bufferCommands: false })
      .then((m) => {
        console.log("[ns-retail] MongoDB connected (wholesale shared DB)");
        return m;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    console.error("[ns-retail] MongoDB connection error:", err);
    throw err;
  }

  return cached.conn;
}
