import { useState } from 'react'
import RegistrationForm from './RegistrationForm'
import './styles/variables.css'

export default function App() {
  const [view, setView] = useState('home')

  const goToLogin = () => {
    window.location.href = '/account/login'
  }

  if (view === 'apply') {
    return <RegistrationForm onBack={goToLogin} />
  }

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 32,
        textAlign: 'center',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'var(--font-family)',
      }}
    >
      <h1 style={{ color: 'var(--color-primary)', fontWeight: 700, fontSize: 40, margin: 0 }}>
        NS Wholesale
      </h1>
      <p style={{ maxWidth: 480, color: 'var(--color-text)', margin: 0, lineHeight: 1.55 }}>
        Apply for a wholesale account to access trade pricing and dedicated support.
      </p>
      <button
        type="button"
        onClick={() => setView('apply')}
        style={{
          background: 'var(--color-primary)',
          color: '#fff',
          border: 'none',
          padding: '14px 40px',
          fontSize: 16,
          fontWeight: 500,
          borderRadius: 8,
          cursor: 'pointer',
          fontFamily: 'var(--font-family)',
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = 'var(--color-primary-hover)')}
        onMouseOut={(e) => (e.currentTarget.style.background = 'var(--color-primary)')}
      >
        Apply for Wholesale
      </button>
    </div>
  )
}
