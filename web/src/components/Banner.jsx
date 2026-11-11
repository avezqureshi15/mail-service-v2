import { useState } from 'react';

/**
 * Icon-led callout for guidance text that used to sit as a bare paragraph
 * above or below a table. Dismissible by default so a long explanation does
 * not have to occupy space once the rep has read it once.
 */

const ICON = {
  info: 'i',
  warning: '!',
  tip: '✨',
  success: '✓',
};

export default function Banner({
  type = 'info', title, children, dismissible = true, className = '',
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className={`banner ${type} ${className}`} role={type === 'warning' ? 'alert' : 'status'}>
      <span className="banner-icon" aria-hidden="true">{ICON[type]}</span>
      <div className="banner-body">
        {title && <strong className="banner-title">{title}</strong>}
        <div className="banner-text">{children}</div>
      </div>
      {dismissible && (
        <button
          type="button"
          className="banner-close"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          &times;
        </button>
      )}
    </div>
  );
}
