import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/practitioner-portal.css'
import { configureApi } from './services/ApiService.jsx'
import PractitionerPortal from './PractitionerPortal.jsx'

const container = document.getElementById('portal-root')

if (container) {
  configureApi({ proxyBase: container.dataset.proxyBase })
  const root = ReactDOM.createRoot(container)
  root.render(
    <React.StrictMode>
      <PractitionerPortal
        loginPageUrl={container.dataset.loginPageUrl}
        supportEmail={container.dataset.supportEmail}
      />
    </React.StrictMode>,
  )
}
