// Standard JSON response shape used across all app routes.
// httpStatus — HTTP status code (200, 400, 500, ...)
// status     — business status flag ('success' | 'error' | ...)
// message    — human-readable message
// result     — payload data (object | array | null)
export const sendResponse = (httpStatus, status, message, result) => {
  return new Response(JSON.stringify({ status, message, result }), {
    status: httpStatus,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  })
}
