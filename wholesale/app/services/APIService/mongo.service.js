// MongoDB connection — the single point of entry for Mongoose.
//
// Cached on `global.mongooseConn` so dev hot-reload (and the multiple
// React Router entrypoints — entry.server, scheduler boot, agenda jobs)
// share one connection instead of pooling per import.

import mongoose from 'mongoose'

const MONGODB_URI = process.env.MONGODB_URI

if (!MONGODB_URI) {
  throw new Error('Please define the MONGODB_URI environment variable in your .env file')
}

// Resolve the database name the SAME way the Shopify session store does
// (shopify.server.js): explicit DATABASE_NAME → the URI path → a final
// default. This keeps Mongoose app data and Shopify sessions in the same DB.
// Without it, a MONGODB_URI with no database in its path falls back to the
// driver default `test`, scattering app data into a `test` database.
function resolveDbName() {
  try {
    const fromPath = new URL(MONGODB_URI).pathname.substring(1)
    return process.env.DATABASE_NAME || fromPath || 'natural-solutions'
  } catch {
    return process.env.DATABASE_NAME || 'natural-solutions'
  }
}

const DB_NAME = resolveDbName()

let cached = global.mongooseConn

if (!cached) {
  cached = global.mongooseConn = { conn: null, promise: null }
}

export default async function connectDB() {
  if (cached.conn) {
    return cached.conn
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, { bufferCommands: false, dbName: DB_NAME })
      .then((m) => {
        console.log('MongoDB connected successfully')
        return m
      })
  }

  try {
    cached.conn = await cached.promise
  } catch (err) {
    cached.promise = null
    console.error('MongoDB connection error:', err)
    throw err
  }

  return cached.conn
}
