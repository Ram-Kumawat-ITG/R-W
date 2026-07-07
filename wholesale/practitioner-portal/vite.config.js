import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Builds the Practitioner Portal React SPA into the theme app extension's
// flat assets/ folder, alongside (but never colliding with) the
// registration-form's react-app-bundle.*. Shopify constraints: no
// subdirectories, predictable filenames, asset URLs must resolve through
// the storefront CDN (handled by practitioner_portal.liquid).
export default defineConfig({
  plugins: [react()],
  // JS-emitted asset URLs resolve via window.__PORTAL_EXT_ASSET_BASE__ (set
  // by the Liquid block from Shopify's asset_url filter). CSS-emitted URLs
  // stay relative — the CSS file lives next to its assets on the CDN.
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') {
        return {
          runtime: `(window.__PORTAL_EXT_ASSET_BASE__ || '/') + ${JSON.stringify(filename)}`,
        }
      }
      return { relative: true }
    },
  },
  build: {
    outDir: resolve(__dirname, '../extensions/theme-extension/assets'),
    // Critical — must not wipe registration-form's react-app-bundle.* output
    // in the same flat assets/ directory.
    emptyOutDir: false,
    assetsDir: '',
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    sourcemap: false,
    // Single-bundle constraint of the theme app extension means we can't
    // code-split; silence Vite's >500kB warning at a sensible ceiling.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.jsx'),
      output: {
        entryFileNames: 'practitioner-portal-bundle.js',
        chunkFileNames: 'practitioner-portal-[name].js',
        assetFileNames: (assetInfo) => {
          const names = assetInfo.names || []
          if (names.some((n) => n.endsWith('.css'))) {
            return 'practitioner-portal-bundle.css'
          }
          return 'practitioner-portal-[name][extname]'
        },
        manualChunks: undefined,
      },
    },
  },
})
