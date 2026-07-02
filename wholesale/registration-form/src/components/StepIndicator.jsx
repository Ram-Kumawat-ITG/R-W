const STEPS = ["About you", "Address & tax", "Payment", "W-9 form"];
const TIME_ESTIMATES = [
  "About 4 minutes",
  "About 2 minutes",
  "About 1 minute",
  "About 1 minute",
];

export default function StepIndicator({ currentStep, onStepClick }) {
  return (
    <div className="rf-progress">
      <div className="rf-progress-meta">
        <span>
          Step <strong>{currentStep}</strong> of {STEPS.length}
        </span>
        <span>{TIME_ESTIMATES[currentStep - 1]}</span>
      </div>

      <div className="rf-stepper">
        {STEPS.map((label, i) => {
          const stepNum = i + 1;
          const state =
            stepNum < currentStep
              ? "done"
              : stepNum === currentStep
                ? "active"
                : "pending";
          const clickable = state === "done" && onStepClick;

          const inner = (
            <>
              <div className="rf-step-circle-wrap">
                {i > 0 && (
                  <div
                    className={`rf-step-line left ${stepNum <= currentStep ? "done" : ""}`}
                  />
                )}
                <div className={`rf-step-circle ${state}`}>
                  {state === "done" ? (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <span>{stepNum}</span>
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={`rf-step-line right ${stepNum < currentStep ? "done" : ""}`}
                  />
                )}
              </div>
              <div className={`rf-step-label ${state}`}>{label}</div>
            </>
          );

          return (
            <div key={label} className="rf-step-node">
              {clickable ? (
                <button
                  type="button"
                  className="rf-step-btn"
                  onClick={() => onStepClick(stepNum)}
                  aria-label={`Go back to step ${stepNum}: ${label}`}
                >
                  {inner}
                </button>
              ) : (
                inner
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
