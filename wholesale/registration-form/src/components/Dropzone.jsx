import { useRef, useState } from 'react'
import { ACCEPTED_FILE_TYPES } from '../constants'

export default function Dropzone({ value, onChange, error }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const handleSelect = (file) => {
    if (file) onChange(file)
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleSelect(file)
  }

  if (value) {
    const sizeKB = value.size / 1024
    const sizeLabel = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB.toFixed(0)} KB`
    return (
      <div className="rf-dropzone has-file">
        <div className="rf-file-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div className="rf-file-info">
          <div className="rf-file-name">{value.name}</div>
          <div className="rf-file-meta">{sizeLabel} · Ready</div>
        </div>
        <button
          type="button"
          className="rf-file-remove"
          onClick={() => onChange(null)}
          aria-label="Remove file"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <>
      <div
        className={`rf-dropzone ${dragOver ? 'drag-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          onChange={(e) => handleSelect(e.target.files?.[0] || null)}
        />
        <svg className="rf-upload-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div className="rf-dropzone-text">
          <strong>Click to upload</strong> or drag and drop
        </div>
        <div className="rf-dropzone-hint">PDF, JPG, or PNG · up to 20 MB</div>
      </div>
      {error && <div className="rf-help error">{error}</div>}
    </>
  )
}
