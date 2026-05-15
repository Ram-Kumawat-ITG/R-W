// Thin wrapper around react-hook-form's trigger() so each step can validate
// only its own fields before advancing.
export function useStepValidation(trigger) {
  return async (fieldNames) => {
    if (!Array.isArray(fieldNames) || fieldNames.length === 0) return true
    return trigger(fieldNames)
  }
}
