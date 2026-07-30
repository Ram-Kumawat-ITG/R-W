import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/client-portal.css'
import ClientPortal from './ClientPortal.jsx'

const container = document.getElementById('ns-client-portal-root')
const config = window.__CLIENT_PORTAL_CONFIG__ || {}

if (container) {
  const root = ReactDOM.createRoot(container)
  root.render(
    <React.StrictMode>
      <ClientPortal loggedIn={!!config.loggedIn} loginPageUrl={config.accountLoginUrl} />
    </React.StrictMode>,
  )
}
