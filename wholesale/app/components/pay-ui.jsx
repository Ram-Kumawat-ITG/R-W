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

// Soft tint used for the ring around the status icon badge.
const TONE_TINTS = {
  success: '#dcfce7',
  critical: '#fee4e2',
  info: '#dbeafe',
  neutral: '#e4e4e7',
}

// Status icon drawn in white inside the accent-filled circle. Success is the
// classic green tick; others get a recognizable glyph for the failure/info case.
function StatusGlyph({ tone }) {
  const common = {
    width: 40,
    height: 40,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: '#fff',
    strokeWidth: 2.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  if (tone === 'critical') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  if (tone === 'info' || tone === 'neutral') {
    return (
      <svg {...common} aria-hidden="true">
        <line x1="12" y1="11" x2="12" y2="16" />
        <circle cx="12" cy="7.5" r="0.6" fill="#fff" stroke="#fff" />
      </svg>
    )
  }
  // success — the green tick
  return (
    <svg {...common} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function PayResult({ tone = 'neutral', title, amount, currency = 'USD', message, action }) {
  const accent = TONE_COLORS[tone] || TONE_COLORS.neutral
  const tint = TONE_TINTS[tone] || TONE_TINTS.neutral
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
      <style dangerouslySetInnerHTML={{ __html: PAY_RESULT_CSS }} />
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
        <div
          className="pay-result-badge"
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 0 8px ${tint}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 28px',
          }}
        >
          <StatusGlyph tone={tone} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a1a', margin: '0 0 12px' }}>{title}</h1>
        {Number.isFinite(amount) && (
          <div style={{ fontSize: 34, fontWeight: 700, color: accent, margin: '0 0 12px' }}>
            {formatMoney(amount, currency)}
          </div>
        )}
        {message && renderMessage(message)}
        {action && (action.onClick || action.href) && (
          action.onClick ? (
            <button type="button" onClick={action.onClick} style={actionStyle(accent, true)}>
              {action.label}
            </button>
          ) : (
            <a href={action.href} style={actionStyle(accent, false)}>
              {action.label}
            </a>
          )
        )}
        <p style={{ fontSize: 12, color: '#a1a1aa', margin: '28px 0 0' }}>Natural Solutions Wholesale</p>
      </div>
    </div>
  )
}

// Render the message as one or more paragraphs. Accepts a string (blank-line-
// separated paragraphs) or an array of lines.
function renderMessage(message) {
  const parts = (Array.isArray(message) ? message : String(message).split(/\n{2,}/))
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.map((part, i) => (
    <p
      key={i}
      style={{
        fontSize: 15,
        lineHeight: 1.6,
        color: '#52525b',
        margin: i === parts.length - 1 ? '0 0 24px' : '0 0 12px',
      }}
    >
      {part}
    </p>
  ))
}

function actionStyle(accent, isButton) {
  return {
    display: 'inline-block',
    background: accent,
    color: '#fff',
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 15,
    padding: '12px 28px',
    borderRadius: 10,
    ...(isButton ? { border: 'none', cursor: 'pointer', fontFamily: 'inherit' } : {}),
  }
}

// Gentle pop-in for the status badge so the result feels acknowledged, not
// abrupt. Respects reduced-motion preferences.
const PAY_RESULT_CSS = `
  @keyframes pay-result-pop {
    0% { transform: scale(0.6); opacity: 0; }
    60% { transform: scale(1.08); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  .pay-result-badge { animation: pay-result-pop .42s cubic-bezier(.2,.8,.2,1) both; }
  @media (prefers-reduced-motion: reduce) {
    .pay-result-badge { animation: none; }
  }
`

export function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return `$${Number(amount).toFixed(2)}`
  }
}
