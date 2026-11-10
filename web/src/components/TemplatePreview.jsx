import { useMemo, useState } from 'react';

const DEVICES = {
  desktop: { label: 'Desktop', width: '100%', height: 560 },
  mobile: { label: 'Mobile', width: 375, height: 560 },
};

/**
 * Renders the message as a recipient would see it, with merge fields filled
 * from sample data.
 *
 * Mobile matters more than it looks: over half of cold outreach is opened on
 * a phone, and a template that only works at 600px wide is a wasted send.
 */
export default function TemplatePreview({ htmlContent, subject, mergeSample }) {
  const [device, setDevice] = useState('desktop');

  const { html, resolvedSubject } = useMemo(() => {
    if (!htmlContent) return { html: '', resolvedSubject: '' };

    const fill = (text) => Object.entries(mergeSample ?? {}).reduce(
      // Replace every occurrence; the field name is interpolated into the
      // pattern, so escape anything regex-significant in it.
      (acc, [key, value]) => acc.replace(
        new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'),
        value,
      ),
      text ?? '',
    );

    return { html: fill(htmlContent), resolvedSubject: fill(subject) };
  }, [htmlContent, subject, mergeSample]);

  const spec = DEVICES[device];

  return (
    <div className="card">
      <div className="step-head">
        <h3 style={{ margin: 0 }}>Live preview</h3>
        <div className="device-toggle">
          {Object.entries(DEVICES).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              className={device === key ? 'active' : ''}
              onClick={() => setDevice(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5 }}>
        As {mergeSample?.first_name ?? 'a recipient'} would see it
      </p>

      {resolvedSubject && (
        <div className="preview-subject">
          <strong>Subject:</strong> {resolvedSubject}
        </div>
      )}

      {html ? (
        <div className="preview-frame-wrap">
          <iframe
            title="Email preview"
            /* Campaign HTML is untrusted input. An empty sandbox blocks
               scripts and denies access to this origin, so a template can
               never reach the session cookie. */
            sandbox=""
            srcDoc={html}
            style={{ width: spec.width, height: spec.height, maxWidth: '100%' }}
          />
        </div>
      ) : (
        <div className="empty" style={{ border: '2px dashed var(--border)', borderRadius: 8 }}>
          Choose a template to see the preview
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        The unsubscribe link and postal address are added when the message is
        sent, so they are not shown here.
      </p>
    </div>
  );
}
