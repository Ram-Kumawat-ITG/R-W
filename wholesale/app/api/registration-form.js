import crypto from 'node:crypto'
import { authenticate } from '../shopify.server'
import connectDB from '../db.server'
import WholesaleApplication from '../models/wholesaleApplication.server'
import { sendResponse } from '../utils/sendResponse'

export async function action({ request }) {
  if (request.method !== 'POST') {
    return sendResponse(405, 'error', 'Method not allowed', null)
  }

  let session, admin
  try {
    const auth = await authenticate.public.appProxy(request)
    session = auth.session
    admin = auth.admin
  } catch (e) {
    console.error('[proxy/submit] appProxy auth failed:', e?.message || e)
    return sendResponse(401, 'error', 'Unauthorized', null)
  }

  if (!admin) {
    console.error('[proxy/submit] admin client unavailable from appProxy auth')
    return sendResponse(500, 'error', 'Admin client unavailable', null)
  }

  const shop = session?.shop || new URL(request.url).searchParams.get('shop') || null

  await connectDB()

  let formData
  try {
    formData = await request.formData()
  } catch (e) {
    console.error('[proxy/submit] formData parse failed:', e?.message || e)
    return sendResponse(400, 'error', 'Invalid form payload', null)
  }

  // Build nested payload from bracketed keys; collect files separately
  const payload = {}
  const fileEntries = []
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'object' && value && typeof value.arrayBuffer === 'function') {
      if (value.size > 0) fileEntries.push({ key, file: value })
      setNested(payload, key, null)
    } else {
      setNested(payload, key, coerce(value))
    }
  }

  // Upload each file to Shopify Files API → get a permanent CDN URL → put it in payload.
  // Upload all files in parallel — sequential awaits would multiply round-trips.
  try {
    const results = await Promise.all(
      fileEntries.map(async ({ key, file }) => {
        const url = await uploadToShopifyFiles(admin, file)
        return { key, url }
      })
    )
    for (const { key, url } of results) {
      setNested(payload, key, url)
    }
  } catch (e) {
    console.error('[proxy/submit] upload failed:', e?.message || e)
    return sendResponse(502, 'error', 'File upload failed', {
      detail: e?.message || String(e),
    })
  }

  // Hash password before storage
  const plain = payload.password
  delete payload.password
  if (plain) {
    const salt = crypto.randomBytes(16).toString('hex')
    const derived = crypto.scryptSync(plain, salt, 64).toString('hex')
    payload.passwordHash = `scrypt:${salt}:${derived}`
  }

  // Hash card number with HMAC-SHA256 (keyed by Shopify app secret). The raw
  // PAN is never persisted or logged. CVV is intentionally not collected.
  if (payload.payment?.cardNumber) {
    const rawPan = String(payload.payment.cardNumber).replace(/\D/g, '')
    delete payload.payment.cardNumber
    if (rawPan) {
      const key = process.env.SHOPIFY_API_SECRET || 'card-hash-fallback-key'
      payload.payment.cardNumberHash = crypto
        .createHmac('sha256', key)
        .update(`card-pan:${rawPan}`)
        .digest('hex')
    }
  }

  // Normalise signature: prefer uploaded PNG file URL, fall back to typed text
  const signedAt = new Date()
  if (payload.signatureFile) {
    payload.signature = {
      type: 'drawn',
      value: payload.signatureFile,
      signedAt,
    }
  } else if (payload.signatureType === 'typed' && payload.signatureValue) {
    payload.signature = {
      type: 'typed',
      value: payload.signatureValue,
      signedAt,
    }
  }
  delete payload.signatureFile
  delete payload.signatureType
  delete payload.signatureValue

  payload.shop = shop

  try {
    const app = await WholesaleApplication.create(payload)
    return sendResponse(200, 'success', 'Application submitted', {
      id: app._id.toString(),
    })
  } catch (e) {
    console.error('[proxy/submit] WholesaleApplication.create failed:', e)
    return sendResponse(500, 'error', 'Failed to save application', {
      detail: e.message,
    })
  }
}

export async function loader() {
  return sendResponse(405, 'error', 'Method not allowed', null)
}

// ---- Shopify Files API helpers ----

// Returns the permanent CDN URL once the file is READY (or throws on failure).
async function uploadToShopifyFiles(admin, file) {
  const isImage = (file.type || '').startsWith('image/')
  const resourceKind = isImage ? 'IMAGE' : 'FILE'

  // 1. Get a staged upload target
  const staged = await admin.graphql(
    `#graphql
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename: file.name || 'upload',
            mimeType: file.type || 'application/octet-stream',
            fileSize: String(file.size),
            httpMethod: 'POST',
            resource: resourceKind,
          },
        ],
      },
    }
  )
  const stagedJson = await staged.json()
  const stagedErrors = stagedJson?.data?.stagedUploadsCreate?.userErrors
  if (stagedErrors?.length) {
    throw new Error(`stagedUploadsCreate: ${stagedErrors.map((e) => e.message).join('; ')}`)
  }
  const target = stagedJson?.data?.stagedUploadsCreate?.stagedTargets?.[0]
  if (!target?.url) throw new Error('No staged target returned')

  // 2. Upload the bytes to the staged target (Shopify-hosted S3-compatible bucket)
  const upload = new FormData()
  for (const p of target.parameters || []) upload.append(p.name, p.value)
  // Shopify expects the file field to be named "file"
  upload.append('file', file, file.name || 'upload')

  const putRes = await fetch(target.url, { method: 'POST', body: upload })
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => '')
    throw new Error(`Staged upload failed (${putRes.status}): ${txt.slice(0, 200)}`)
  }

  // 3. Register the uploaded resource as a Shopify File
  const created = await admin.graphql(
    `#graphql
    mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage { image { url } }
          ... on GenericFile { url }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        files: [
          {
            originalSource: target.resourceUrl,
            contentType: resourceKind,
            alt: file.name || 'upload',
          },
        ],
      },
    }
  )
  const createdJson = await created.json()
  const createErrors = createdJson?.data?.fileCreate?.userErrors
  if (createErrors?.length) {
    throw new Error(`fileCreate: ${createErrors.map((e) => e.message).join('; ')}`)
  }
  const created0 = createdJson?.data?.fileCreate?.files?.[0]
  if (!created0?.id) throw new Error('fileCreate returned no file')

  // If fileCreate already returned a URL (often the case for direct uploads),
  // skip the polling round-trip and use it.
  const immediateUrl = created0?.url || created0?.image?.url
  if (immediateUrl) return immediateUrl

  // Otherwise poll — tight cadence so we don't drag out submit time.
  const url = await pollFileUntilReady(admin, created0.id)
  return url
}

async function pollFileUntilReady(admin, fileId, { tries = 6, delayMs = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await admin.graphql(
      `#graphql
      query FileById($id: ID!) {
        node(id: $id) {
          ... on MediaImage { fileStatus image { url } }
          ... on GenericFile { fileStatus url }
        }
      }`,
      { variables: { id: fileId } }
    )
    const json = await res.json()
    const node = json?.data?.node
    const status = node?.fileStatus
    const url = node?.url || node?.image?.url

    if (url) return url
    if (status === 'FAILED') throw new Error('File processing failed')

    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error('File not READY after timeout')
}

// ---- nested-key helpers ----

function setNested(obj, path, value) {
  const keys = parsePath(path)
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}

function parsePath(path) {
  const out = []
  const re = /([^[\]]+)/g
  let m
  while ((m = re.exec(path)) !== null) out.push(m[1])
  return out
}

function coerce(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  return v
}
