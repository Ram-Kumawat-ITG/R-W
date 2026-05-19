// Shared request/response helpers used by every inbound HTTP handler.
//
// New handlers should import from here rather than rolling their own
// response-shaping code. Keeps the contract uniform so frontend clients
// can rely on `{ status, message, result }` everywhere.

// Standard JSON response shape used across all app routes.
// httpStatus — HTTP status code (200, 400, 500, ...)
// status     — business status flag ('success' | 'error' | ...)
// message    — human-readable message
// result     — payload data (object | array | null)
export function sendResponse(httpStatus, status, message, result) {
  return new Response(JSON.stringify({ status, message, result }), {
    status: httpStatus,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

// Convenience constructors for the most common shapes. Use these in route
// handlers instead of memorizing the (status, flag, message, result) order.
export const ok = (message = 'OK', result = null) => sendResponse(200, 'success', message, result)
export const badRequest = (message = 'Bad request', result = null) =>
  sendResponse(400, 'error', message, result)
export const unauthorized = (message = 'Unauthorized', result = null) =>
  sendResponse(401, 'error', message, result)
export const methodNotAllowed = (message = 'Method not allowed') =>
  sendResponse(405, 'error', message, null)
export const serverError = (message = 'Internal server error', result = null) =>
  sendResponse(500, 'error', message, result)
