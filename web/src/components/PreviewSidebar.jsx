import { useState } from 'react';
import TemplatePreview from './TemplatePreview.jsx';

export default function PreviewSidebar({ lint, step, mergeSample }) {
  const [activeTab, setActiveTab] = useState('preview');

  return (
    <div className="preview-sidebar">
      <div className="preview-tabs-header">
        <button
          type="button"
          className={`tab-button ${activeTab === 'preview' ? 'active' : ''}`}
          onClick={() => setActiveTab('preview')}
        >
          📧 Preview
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === 'health' ? 'active' : ''}`}
          onClick={() => setActiveTab('health')}
        >
          ✓ Health Check
        </button>
      </div>

      {activeTab === 'preview' && (
        <div className="tab-content">
          <TemplatePreview
            htmlContent={step?.htmlBody || ''}
            subject={step?.subject || ''}
            mergeSample={mergeSample}
          />
        </div>
      )}

      {activeTab === 'health' && (
        <HealthCheckPanel lint={lint} />
      )}
    </div>
  );
}

function HealthCheckPanel({ lint }) {
  if (!lint) {
    return (
      <div className="card">
        <h3>Content Check</h3>
        <p className="muted">Start typing to see the score.</p>
      </div>
    );
  }

  const blockers = lint.findings.filter((f) => f.severity === 'block');

  return (
    <div className="card" style={{ position: 'sticky', top: 20 }}>
      <h3>Content Check</h3>

      <div className={`score ${lint.rating}`}>
        <span className="num">{lint.score}</span>
        <span className="muted">/ 100 &middot; {lint.rating}</span>
      </div>

      <div className="bar" style={{ marginBottom: 14 }}>
        <span
          style={{ width: `${lint.score}%` }}
          className={lint.rating === 'good' ? 'good' : lint.rating === 'fair' ? 'warn' : 'bad'}
        />
      </div>

      {blockers.length > 0 && (
        <div className="alert error">
          This cannot be sent until {blockers.length === 1 ? 'this is' : 'these are'} fixed.
        </div>
      )}

      {lint.findings.length === 0 ? (
        <p className="muted">Nothing flagged. This reads like a clean message.</p>
      ) : (
        lint.findings.map((finding, index) => (
          <div key={index} className={`finding ${finding.severity}`}>
            <div className="msg">{finding.message}</div>
            {finding.hint && <div className="hint">{finding.hint}</div>}
          </div>
        ))
      )}

      <div className="grid cols-4" style={{ marginTop: 16 }}>
        <Mini label="Words" value={lint.stats.words} />
        <Mini label="Links" value={lint.stats.links} />
        <Mini label="Images" value={lint.stats.images} />
        <Mini label="Subject" value={lint.stats.subjectLength} />
      </div>
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div>
      <div className="label muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 650 }}>{value}</div>
    </div>
  );
}
