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
      .connect(MONGODB_URI, { bufferCommands: false })
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
