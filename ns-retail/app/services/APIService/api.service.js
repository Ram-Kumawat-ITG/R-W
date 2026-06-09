// Shared request/response helpers used by inbound HTTP handlers.
//
// Ported from the wholesale app so the Practitioner Portal endpoints
// (app/api/portal/*) keep a uniform `{ status, message, result }` contract
// that the Customer Account UI extension relies on. New ns-retail handlers
// may use these instead of rolling their own response-shaping code.

// Standard JSON response shape used across portal routes.
// httpStatus — HTTP status code (200, 400, 500, ...)
// status     — business status flag ('success' | 'error' | ...)
// message    — human-readable message
// result     — payload data (object | array | null)
export function sendResponse(httpStatus, status, message, result) {
  return new Response(JSON.stringify({ status, message, result }), {
    status: httpStatus,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// Convenience constructors for the most common shapes. Use these in route
// handlers instead of memorizing the (status, flag, message, result) order.
export const ok = (message = "OK", result = null) =>
  sendResponse(200, "success", message, result);
export const badRequest = (message = "Bad request", result = null) =>
  sendResponse(400, "error", message, result);
export const unauthorized = (message = "Unauthorized", result = null) =>
  sendResponse(401, "error", message, result);
export const methodNotAllowed = (message = "Method not allowed") =>
  sendResponse(405, "error", message, null);
export const serverError = (message = "Internal server error", result = null) =>
  sendResponse(500, "error", message, result);
