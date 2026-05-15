// Flattens the nested form values into a multipart FormData payload.
//   - File / Blob values become file parts
//   - Booleans -> "true" / "false"
//   - null / undefined / internal _-prefixed keys -> skipped
//   - Everything else -> string
export function buildFormData(values) {
  const fd = new FormData()
  walk(values, '', fd)
  return fd
}

function walk(value, prefix, fd) {
  if (value === null || value === undefined) return

  // File or Blob entries
  if (typeof File !== 'undefined' && value instanceof File) {
    fd.append(prefix, value, value.name)
    return
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    fd.append(prefix, value, prefix)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${prefix}[${i}]`, fd))
    return
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      // Skip internal hooks like payment._stripe (live Stripe instance handles)
      if (k.startsWith('_')) return
      const next = prefix ? `${prefix}[${k}]` : k
      walk(v, next, fd)
    })
    return
  }

  if (typeof value === 'boolean') {
    fd.append(prefix, value ? 'true' : 'false')
    return
  }

  fd.append(prefix, String(value))
}
