// Customer Account UI extension HTTP client.
//
// One class. Specific method per backend endpoint. Each method:
//   1. Builds Headers — Content-Type: application/json
//                      + Authorization: Bearer ${token}
//   2. Builds request options
//   3. Fetches the absolute URL `${SERVER_URL}/api/portal/<name>`
//   4. Returns parsed JSON or the caught error
//
// Auth via session-token JWT (the same auth the registration form's reference
// uses). The caller fetches the token via `shopify.sessionToken.get()` and
// passes it as the first arg to every method. The backend verifies the
// token via `authenticate.public.customerAccount(request)` and reads
// the customer GID from the token's `sub` claim — body identity is
// trusted as a hint at most.
//
// Usage:
//   import ApiService from "../../services/FullPageApi.jsx"
//   const api = new ApiService()
//   const token = await shopify.sessionToken.get()
//   const res   = await api.fetchProfile(token, customerId)

const SERVER_URL = "https://achievements-both-website-dated.trycloudflare.com" || process.env.SHOPIFY_APP_URL

export default class FullPageApi {
  // Static helper exposed so non-API callers (e.g. card-update popup
  // opener) can build URLs to non-/api/portal/* routes on the same backend.
  static getAppBaseUrl() {
    return String(SERVER_URL || '').replace(/\/+$/, '')
  }

  // ── Profile (read) ───────────────────────────────────────────────────
  async fetchProfile(token, customerId) {
    const myHeaders = new Headers()
    myHeaders.append('Content-Type', 'application/json')
    myHeaders.append('Authorization', `Bearer ${token}`)
    const requestOptions = {
      method: 'POST',
      headers: myHeaders,
      body: JSON.stringify({ customerId, action: 'fetch' }),
      redirect: 'follow',
    }
    return fetch(`${SERVER_URL}/api/portal/profile`, requestOptions)
      .then((response) => response.json())
      .then((result) => result)
      .catch((error) => {
        console.error('Error fetching profile:', error)
        return error
      })
  }

  // ── Profile (update — JSON) ──────────────────────────────────────────
  // `sections` is the same shape the storefront sends — { business, tax,
  // payment, card, ach, commission, w9 }. Omitted sections are not touched.
  async updateProfile(token, customerId, sections) {
    const myHeaders = new Headers()
    myHeaders.append('Content-Type', 'application/json')
    myHeaders.append('Authorization', `Bearer ${token}`)
    const requestOptions = {
      method: 'POST',
      headers: myHeaders,
      body: JSON.stringify({ customerId, action: 'update', ...sections }),
      redirect: 'follow',
    }
    return fetch(`${SERVER_URL}/api/portal/profile`, requestOptions)
      .then((response) => response.json())
      .then((result) => result)
      .catch((error) => {
        console.error('Error updating profile:', error)
        return error
      })
  }

  // ── Profile (update — multipart, for files) ──────────────────────────
  // Use this when uploading credential license files or a drawn W-9
  // signature. The browser sets the multipart Content-Type itself — do
  // NOT set it manually.
  //   files = { credentialFiles: { [credKey]: File }, w9SignatureFile?: File }
  async updateProfileWithFiles(token, customerId, sections, files) {
    const myHeaders = new Headers()
    myHeaders.append('Authorization', `Bearer ${token}`)
    // Intentionally NO Content-Type — the browser sets it with the
    // multipart boundary automatically.

    const form = new FormData()
    form.append(
      'payload',
      JSON.stringify({ customerId, action: 'update', ...sections }),
    )
    if (files?.w9SignatureFile) {
      form.append('w9SignatureFile', files.w9SignatureFile)
    }
    if (files?.credentialFiles) {
      for (const [credKey, file] of Object.entries(files.credentialFiles)) {
        if (file) form.append(`credentialFile:${credKey}`, file)
      }
    }
    const requestOptions = {
      method: 'POST',
      headers: myHeaders,
      body: form,
      redirect: 'follow',
    }
    return fetch(`${SERVER_URL}/api/portal/profile`, requestOptions)
      .then((response) => response.json())
      .then((result) => result)
      .catch((error) => {
        console.error('Error updating profile with files:', error)
        return error
      })
  }

  // (mintCardPopupToken removed — server-side tokenization is used now;
  //  the card update is sent as part of the regular updateProfile call
  //  with raw card fields in the `card` section. See profile.service.js
  //  for the PCI-relevant handling.)
}
