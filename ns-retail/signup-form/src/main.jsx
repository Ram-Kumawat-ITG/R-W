import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Mount only if the storefront block's root div is present. Protects against
// the bundle being loaded on a page that doesn't have the signup_form block.
const container = document.getElementById('ns-signup-root')

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
