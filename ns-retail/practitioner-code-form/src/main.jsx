import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Mount point injected by the theme block. When running via `npm run dev`
// (standalone), index.html supplies the same #ns-practitioner-code-root.
const mount = document.getElementById('ns-practitioner-code-root')
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
