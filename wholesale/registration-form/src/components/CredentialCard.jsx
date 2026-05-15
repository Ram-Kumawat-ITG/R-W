import { Controller } from 'react-hook-form'
import Dropzone from './Dropzone'

export default function CredentialCard({ cred, control, onRemove, errors }) {
  const docsHaveTwoTextInputs =
    cred.docs.filter((d) => d.type === 'text' || d.type === 'select').length === 2

  return (
    <div className="rf-cred-card">
      <div className="rf-cred-head">
        <div className="rf-cred-title">
          <span className="rf-check-pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          {cred.name}
        </div>
        <button type="button" className="rf-cred-uncheck" onClick={onRemove}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Remove
        </button>
      </div>
      <div className={`rf-cred-fields ${docsHaveTwoTextInputs ? 'two-col' : ''}`}>
        {cred.docs.map((doc, idx) => {
          if (doc.type === 'file') {
            const fieldName = `credentials.${cred.id}.file${idx}`
            const fieldError = errors?.credentials?.[cred.id]?.[`file${idx}`]?.message
            return (
              <div key={idx}>
                <label className="rf-label">
                  {doc.label} <span className="rf-req">*</span>
                </label>
                <Controller
                  name={fieldName}
                  control={control}
                  defaultValue={null}
                  render={({ field }) => (
                    <Dropzone value={field.value} onChange={field.onChange} error={fieldError} />
                  )}
                />
              </div>
            )
          }
          if (doc.type === 'text') {
            const fieldName = `credentials.${cred.id}.${doc.key}`
            const fieldError =
              errors?.credentials?.[cred.id]?.[doc.key]?.message
            return (
              <div key={idx}>
                <label className="rf-label">
                  {doc.label} <span className="rf-req">*</span>
                </label>
                <Controller
                  name={fieldName}
                  control={control}
                  defaultValue=""
                  render={({ field }) => (
                    <input
                      {...field}
                      type="text"
                      placeholder={doc.placeholder || ''}
                      className={`rf-input ${fieldError ? 'error' : ''}`}
                    />
                  )}
                />
                {doc.hint && !fieldError && <p className="rf-help">{doc.hint}</p>}
                {fieldError && <p className="rf-help error">{fieldError}</p>}
              </div>
            )
          }
          if (doc.type === 'select') {
            const fieldName = `credentials.${cred.id}.${doc.key}`
            const fieldError =
              errors?.credentials?.[cred.id]?.[doc.key]?.message
            return (
              <div key={idx}>
                <label className="rf-label">
                  {doc.label} <span className="rf-req">*</span>
                </label>
                <Controller
                  name={fieldName}
                  control={control}
                  defaultValue=""
                  render={({ field }) => (
                    <select {...field} className={`rf-select ${fieldError ? 'error' : ''}`}>
                      <option value="">Select…</option>
                      {doc.options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  )}
                />
                {fieldError && <p className="rf-help error">{fieldError}</p>}
              </div>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}
