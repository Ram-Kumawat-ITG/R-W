import { useState } from 'react'
import SignupForm from './SignupForm.jsx'
import './App.css'

function SuccessScreen({ customerEmail }) {
  return (
    <div className="ns-signup-page">
      <div className="ns-signup-card">
        <div className="ns-success-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="28"
            height="28"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h1>Account created</h1>
        <p className="ns-signup-subtitle">
          Welcome! We sent an activation email to{' '}
          <strong>{customerEmail || 'your inbox'}</strong>. Click the link in
          that email to set up your account and start shopping.
        </p>
        <a href="/account/login" className="ns-submit ns-submit-link">
          Go to login
        </a>
      </div>
    </div>
  )
}

export default function App() {
  const [success, setSuccess] = useState(null)

  if (success) {
    return <SuccessScreen customerEmail={success.email} />
  }

  return <SignupForm onSuccess={setSuccess} />
}
