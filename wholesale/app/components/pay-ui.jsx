// Presentational shell for the public, non-embedded /pay/* pages. These
// render inside root.jsx's plain document (no Polaris / App Bridge), so the
// styling is self-contained inline CSS. Pure render — no config/service
// imports — safe in the client bundle.

const TONE_COLORS = {
  success: '#0f7b3f',
  critical: '#b42318',
  info: '#1f6feb',
  neutral: '#3a3a3a',
}

export function PayResult({ tone = 'neutral', title, amount, currency = 'USD', message, action }) {
  const accent = TONE_COLORS[tone] || TONE_COLORS.neutral
  return (
    <div
      style={{
        minHeight: '100vh',
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f4f5f7',
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          boxShadow: '0 1px 3px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.06)',
          maxWidth: 460,
          width: '100%',
          padding: '40px 36px',
          textAlign: 'center',
        }}
      >
        <div style={{ height: 4, width: 56, background: accent, borderRadius: 4, margin: '0 auto 24px' }} />
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a1a', margin: '0 0 12px' }}>{title}</h1>
        {Number.isFinite(amount) && (
          <div style={{ fontSize: 34, fontWeight: 700, color: accent, margin: '0 0 12px' }}>
            {formatMoney(amount, currency)}
          </div>
        )}
        {message && (
          <p style={{ fontSize: 15, lineHeight: 1.55, color: '#52525b', margin: '0 0 24px' }}>{message}</p>
        )}
        {action?.href && (
          <a
            href={action.href}
            style={{
              display: 'inline-block',
              background: accent,
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: 15,
              padding: '12px 28px',
              borderRadius: 10,
            }}
          >
            {action.label}
          </a>
        )}
        <p style={{ fontSize: 12, color: '#a1a1aa', margin: '28px 0 0' }}>Natural Solutions Wholesale</p>
      </div>
    </div>
  )
}

export function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return `$${Number(amount).toFixed(2)}`
  }
}
