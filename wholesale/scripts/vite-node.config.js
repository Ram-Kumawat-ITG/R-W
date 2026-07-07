// Minimal Vite config just for running one-off scripts/*.js under vite-node
// (needed because the app's ESM source uses extensionless relative imports,
// e.g. `from './qbo.apis'`, which plain `node` cannot resolve without a
// bundler). Deliberately does NOT reuse the app's vite.config.js — that one
// restricts server.fs.allow to ["app", "node_modules"], which blocks
// vite-node from reading files under scripts/.
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  server: {
    fs: { allow: ['..'] },
  },
})
