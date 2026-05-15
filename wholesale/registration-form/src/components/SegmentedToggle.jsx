// Reusable yes/no (or arbitrary 2+) segmented control. Pure controlled.
export default function SegmentedToggle({ value, onChange, options }) {
  return (
    <div className="rf-segmented" role="group">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
