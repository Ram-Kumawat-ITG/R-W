import { useEffect, useRef, useState } from 'react'

// Draw-only signature pad. Writes { drawn } back via onChange (drawn is a PNG Blob).
export default function SignaturePad({ value, onChange, error }) {
  const canvasRef = useRef(null)
  const ctxRef = useRef(null)
  const drawingRef = useRef(false)
  const lastRef = useRef({ x: 0, y: 0 })
  const [hasInk, setHasInk] = useState(false)
  const savedBlobRef = useRef(value?.drawn instanceof Blob ? value.drawn : null)

  useEffect(() => {
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

    if (savedBlobRef.current) {
      const blob = savedBlobRef.current
      savedBlobRef.current = null
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height)
        URL.revokeObjectURL(url)
        setHasInk(true)
      }
      img.src = url
    }
  }, [])

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
      onChange({ drawn: blob })
    }, 'image/png')
  }

  const clear = () => {
    const ctx = ctxRef.current
    if (ctx) {
      const dpr = window.devicePixelRatio || 1
      ctx.clearRect(0, 0, canvasRef.current.width / dpr, canvasRef.current.height / dpr)
    }
    setHasInk(false)
    onChange({ drawn: null })
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
      </div>

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

      <div className="rf-sig-footer">
        <button
          type="button"
          className="rf-sig-clear"
          onClick={clear}
          disabled={!hasInk}
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
