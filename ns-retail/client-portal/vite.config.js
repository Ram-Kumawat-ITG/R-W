import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Builds the Client Portal React app into the theme app extension's flat
// assets/ folder. Mirrors ns-retail/practitioner-code-form/vite.config.js —
// same Shopify constraints (no subdirectories, predictable filenames,
// asset URLs resolve through the storefront CDN via the Liquid block).
export default defineConfig({
  plugins: [react()],
  // Read .env from the ns-retail/ root so this app picks up the same
  // env vars the React Router server uses.
  envDir: resolve(__dirname, '..'),
  // JS-emitted asset URLs resolve via window.__CLIENT_PORTAL_ASSET_BASE__
  // (set by the Liquid block from Shopify's asset_url filter). CSS-emitted
  // URLs stay relative — the CSS file lives next to its assets on the CDN.
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') {
        return {
          runtime: `(window.__CLIENT_PORTAL_ASSET_BASE__ || '/') + ${JSON.stringify(filename)}`,
        }
      }
      return { relative: true }
    },
  },
  build: {
    outDir: resolve(__dirname, '../extensions/theme-extension/assets'),
    emptyOutDir: false, // Don't wipe signup-bundle / practitioner-code-bundle / etc.
    assetsDir: '',
    cssCodeSplit: false,
    assetsInlineLimit: 4096,
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: resolve(__dirname, 'src/main.jsx'),
      output: {
        entryFileNames: 'client-portal-bundle.js',
        chunkFileNames: 'client-portal-[name].js',
        assetFileNames: (assetInfo) => {
          const names = assetInfo.names || []
          if (names.some((n) => n.endsWith('.css'))) {
            return 'client-portal-bundle.css'
          }
          return 'client-portal-[name][extname]'
        },
        manualChunks: undefined,
      },
    },
  },
})
