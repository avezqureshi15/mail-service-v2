export const WIZARD_STEPS = [
  { id: 1, label: 'Setup & Audience' },
  { id: 2, label: 'Template Selection' },
  { id: 3, label: 'Design & Content' },
  { id: 4, label: 'Review & Send' },
];

/**
 * Top-level progress bar. A step is only clickable once you've reached it -
 * `maxStepReached` tracks the furthest point, so jumping back to tweak
 * something is free but you can't skip ahead of what you've actually filled
 * in (picking a template, writing the copy) by clicking forward.
 */
export default function WizardStepper({ currentStep, maxStepReached, onJump }) {
  return (
    <div className="wizard-stepper">
      {WIZARD_STEPS.map((step, i) => {
        const reachable = step.id <= maxStepReached;
        const state = step.id < currentStep ? 'done' : step.id === currentStep ? 'active' : 'pending';
        return (
          <div className="wizard-stepper-item" key={step.id}>
            <button
              type="button"
              className={`wizard-step-btn ${state}`}
              disabled={!reachable}
              onClick={() => onJump(step.id)}
            >
              <span className="wizard-step-num">{state === 'done' ? '✓' : step.id}</span>
              <span className="wizard-step-label">{step.label}</span>
            </button>
            {i < WIZARD_STEPS.length - 1 && <span className="wizard-step-connector" />}
          </div>
        );
      })}
    </div>
  );
}
