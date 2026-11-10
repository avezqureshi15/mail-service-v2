/**
 * Sticky top bar for the campaign wizard: identity and status on the left,
 * the actions that apply regardless of which step you're on (save, step
 * navigation) on the right.
 */
export default function WizardHeader({
  campaignName,
  onBack,
  onSaveDraft,
  saving,
  showPrevious,
  onPrevious,
  showContinue,
  onContinue,
  continueDisabled,
  continueLabel = 'Continue',
}) {
  return (
    <div className="wizard-header">
      <div className="wizard-header-left">
        <button type="button" className="secondary small" onClick={onBack}>
          &larr; Back to Campaigns
        </button>
        <div className="wizard-header-title">
          <strong>{campaignName?.trim() || 'New campaign'}</strong>
          <span className="status-badge draft">Draft</span>
        </div>
      </div>

      <div className="wizard-header-right">
        <button type="button" className="secondary" onClick={onSaveDraft} disabled={saving}>
          {saving ? 'Saving...' : 'Save Draft'}
        </button>
        {showPrevious && (
          <button type="button" className="secondary" onClick={onPrevious}>Back</button>
        )}
        {showContinue && (
          <button type="button" onClick={onContinue} disabled={continueDisabled}>
            {continueLabel}
          </button>
        )}
      </div>
    </div>
  );
}
