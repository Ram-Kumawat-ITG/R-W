const proxy = import.meta.env.VITE_PROXY;
const PROXY_BASE = proxy || 'wholesale-application'

console.log('PROXY_BASE:', PROXY_BASE)

export default class ApiService {
  static async submitRegistration(formData) {
    const url = `/apps/${PROXY_BASE}/api/registration-form`

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        body: formData,
      })
    } catch (err) {
      console.error('[ApiService.submitRegistration] network error:', err)
      throw new Error('Network error. Please check your connection and try again.')
    }

    let data
    try {
      data = await response.json()
    } catch {
      data = {}
    }

    if (!response.ok || data.status === 'error') {
      const err = new Error(data.message || `Submit failed (${response.status})`)
      err.responseData = data
      throw err
    }

    return data
  }
}
