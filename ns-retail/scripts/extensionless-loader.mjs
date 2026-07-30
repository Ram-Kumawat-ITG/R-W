// Node ESM loader hook: app/ code uses extensionless relative imports
// everywhere (e.g. `from "../../shopify.server"`), which Vite/React
// Router's own dev server resolves automatically but plain `node` does
// not — it requires an explicit `.js`. Standalone scripts (like
// migrate-practitioner-discounts.js) run outside that dev server and need
// this shim so they can import app/ modules without editing hundreds of
// existing import statements across the codebase.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      specifier.startsWith(".") &&
      (err.code === "ERR_MODULE_NOT_FOUND" ||
        err.code === "ERR_UNSUPPORTED_DIR_IMPORT")
    ) {
      for (const suffix of [".js", "/index.js"]) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          // try the next suffix
        }
      }
    }
    throw err;
  }
}
