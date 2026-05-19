import { useEffect, useRef, useState } from 'react'

// Controlled signature pad: writes { type, drawn, typed } back via onChange.
// `drawn` is a Blob (PNG) when the user has signed in draw mode.
export default function SignaturePad({ value, onChange, error }) {
  const mode = value?.type || 'draw'
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const drawingRef = useRef(false)
  const lastRef = useRef({ x: 0, y: 0 })
  // Start false so a mouseleave on mount never triggers a toBlob on a blank canvas.
  // setHasInk(true) is called after the existing blob is restored to the canvas.
  const [hasInk, setHasInk] = useState(false)
  // Capture the blob that existed when this component mounted so we can restore it.
  const savedBlobRef = useRef(value?.drawn instanceof Blob ? value.drawn : null)

  // Init canvas — and restore any previously drawn signature on re-mount.
  useEffect(() => {
    if (mode !== 'draw') return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#1F1B16'
    ctxRef.current = ctx

    // If the user navigated back then forward, restore the saved signature.
    if (savedBlobRef.current) {
      const blob = savedBlobRef.current
      savedBlobRef.current = null          // restore only once
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height)
        URL.revokeObjectURL(url)
        setHasInk(true)
      }
      img.src = url
    }
  }, [mode])

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const t = e.touches ? e.touches[0] : e
    return { x: t.clientX - rect.left, y: t.clientY - rect.top }
  }

  const startDraw = (e) => {
    e.preventDefault()
    drawingRef.current = true
    const p = getPos(e)
    lastRef.current = p
    const ctx = ctxRef.current
    ctx.beginPath()
    ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2)
    ctx.fillStyle = '#1F1B16'
    ctx.fill()
    setHasInk(true)
  }

  const moveDraw = (e) => {
    if (!drawingRef.current) return
    e.preventDefault()
    const p = getPos(e)
    const ctx = ctxRef.current
    ctx.beginPath()
    ctx.moveTo(lastRef.current.x, lastRef.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    lastRef.current = p
  }

  const endDraw = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (!hasInk) return
    canvasRef.current.toBlob((blob) => {
      onChange({ ...value, type: 'draw', drawn: blob })
    }, 'image/png')
  }

  const clear = () => {
    if (mode === 'draw') {
      const ctx = ctxRef.current
      if (ctx) {
        const dpr = window.devicePixelRatio || 1
        ctx.clearRect(0, 0, canvasRef.current.width / dpr, canvasRef.current.height / dpr)
      }
      setHasInk(false)
      onChange({ ...value, type: 'draw', drawn: null })
    } else {
      onChange({ ...value, type: 'type', typed: '' })
    }
  }

  const setMode = (next) => {
    onChange({ ...value, type: next })
    if (next === 'draw') setHasInk(false)
  }

  const dateText = `Signed ${new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })}`

  return (
    <div>
      <div className="rf-sig-header">
        <label className="rf-label" style={{ marginBottom: 0 }}>
          Sign below <span className="rf-req">*</span>
        </label>
        <div className="rf-sig-mode">
          <button
            type="button"
            className={mode === 'draw' ? 'active' : ''}
            onClick={() => setMode('draw')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
              <path d="M3 21c4-3 5-4 8-7 4-4 7-7 10-8" />
              <path d="M11 14c0-3 1-4 3-4s3 1 3 3-3 4-3 4" />
            </svg>
            Draw
          </button>
          <button
            type="button"
            className={mode === 'type' ? 'active' : ''}
            onClick={() => setMode('type')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
              <polyline points="4 7 4 4 20 4 20 7" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
            Type
          </button>
        </div>
      </div>

      {mode === 'draw' ? (
        <div className={`rf-sig-canvas-wrap ${hasInk ? 'has-signature' : ''}`}>
          <canvas
            ref={canvasRef}
            className="rf-sig-canvas"
            onMouseDown={startDraw}
            onMouseMove={moveDraw}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            onTouchStart={startDraw}
            onTouchMove={moveDraw}
            onTouchEnd={endDraw}
          />
          <div className="rf-sig-baseline" />
          {!hasInk && (
            <span className="rf-sig-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M3 21c4-3 5-4 8-7 4-4 7-7 10-8" />
              </svg>
              Sign here with your mouse or finger
            </span>
          )}
        </div>
      ) : (
        <div className="rf-sig-type-area">
          <input
            type="text"
            className="rf-sig-input"
            placeholder="Type your full name"
            value={value?.typed || ''}
            onChange={(e) => onChange({ ...value, type: 'type', typed: e.target.value })}
          />
        </div>
      )}

      <div className="rf-sig-footer">
        <button
          type="button"
          className="rf-sig-clear"
          onClick={clear}
          disabled={
            mode === 'draw' ? !hasInk : !(value?.typed && value.typed.trim())
          }
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Clear and re-sign
        </button>
        <div className="rf-sig-meta">
          <span>Legally binding under ESIGN/UETA</span>
          <span>{dateText}</span>
        </div>
      </div>

      {error && <div className="rf-help error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  )
}
