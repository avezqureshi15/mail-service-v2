/**
 * Step 4: a last look before anything goes out. The checklist mirrors exactly
 * what `/campaigns/:id/start` actually checks server-side (list selected,
 * content present) - nothing here can pass while the real send would fail.
 * Sender address isn't on the checklist: it's always the server's configured
 * mailbox, so there's nothing to be incomplete.
 */
export default function StepReviewSend({
  form,
  firstStep,
  selectedList,
  configuredFromAddress,
  checklist,
  readyToLaunch,
  busy,
  error,
  blockers,
  onSaveDraft,
  onSendNow,
}) {
  return (
    <div className="wizard-page-inner" style={{ maxWidth: 820 }}>
      <div className="card">
        <h3>Summary</h3>
        <div className="review-summary">
          <div className="item">
            <div className="label">Campaign</div>
            <div className="value">{form.name || 'Untitled'}</div>
          </div>
          <div className="item">
            <div className="label">Subject</div>
            <div className="value">{firstStep.subject || '--'}</div>
          </div>
          <div className="item">
            <div className="label">Audience</div>
            <div className="value">{selectedList ? `${selectedList.name} (${selectedList.contact_count})` : 'Not selected'}</div>
          </div>
          <div className="item">
            <div className="label">Sender</div>
            <div className="value">{form.fromName || configuredFromAddress || 'Service default'}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Pre-flight checklist</h3>
        <div className="review-grid">
          {checklist.map((item) => (
            <div key={item.label} className={`review-card ${item.done ? 'done' : 'pending'}`}>
              <span className="review-icon">{item.done ? '✓' : '○'}</span>
              <div>
                <strong>{item.label}</strong>
              </div>
            </div>
          ))}
        </div>

        {error && <div className="alert error" style={{ marginTop: 16 }}>{error}</div>}
        {blockers.length > 0 && (
          <div className="alert error" style={{ marginTop: error ? 10 : 16 }}>
            <strong>Fix these before sending:</strong>
            <ul>{blockers.map((b, i) => <li key={i}>{b.message ?? b.field}</li>)}</ul>
          </div>
        )}

        <div className="action-footer">
          <p className="hint">
            {readyToLaunch
              ? 'Everything required is in place. Sending starts immediately and cannot be undone.'
              : 'Finish the items above before this campaign can send.'}
          </p>
          <div className="actions">
            <button type="button" className="secondary" onClick={onSaveDraft} disabled={busy}>
              {busy ? 'Saving...' : 'Save Draft'}
            </button>
            <button type="button" onClick={onSendNow} disabled={busy || !readyToLaunch}>
              {busy ? 'Sending...' : 'Send Campaign Now'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
