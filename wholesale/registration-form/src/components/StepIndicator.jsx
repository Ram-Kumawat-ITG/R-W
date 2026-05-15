const STEPS = ['About you', 'Address & tax', 'Payment']
const TIME_ESTIMATES = ['About 4 minutes', 'About 2 minutes', 'About 1 minute']

export default function StepIndicator({ currentStep }) {
  return (
    <div className="rf-progress">
      <div className="rf-progress-meta">
        <span>
          Step <strong>{currentStep}</strong> of {STEPS.length}
        </span>
        <span>{TIME_ESTIMATES[currentStep - 1]}</span>
      </div>
      <div className="rf-progress-track">
        {STEPS.map((_, i) => {
          const stepNum = i + 1
          const className =
            stepNum < currentStep ? 'rf-progress-seg done'
            : stepNum === currentStep ? 'rf-progress-seg active'
            : 'rf-progress-seg'
          return <div key={i} className={className} />
        })}
      </div>
      <div className="rf-step-pills">
        {STEPS.map((label, i) => (
          <span key={label} className={i + 1 === currentStep ? 'active' : ''}>
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
