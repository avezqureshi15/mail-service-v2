import { useEffect } from 'react';
import { useTemplates } from '../../lib/useTemplates.js';
import TemplateGrid from './TemplateGrid.jsx';

/**
 * Slide-out picker for a single step in Design & Content.
 *
 * Purely presentational - it has no idea whether the step it's picking for
 * already has content, so it never decides whether to warn before replacing
 * it. That decision (and the actual fetch-and-apply) belongs to whoever
 * opened it, which knows the step.
 */
export default function TemplateDrawer({
  stepLabel, onClose, onChoose, onClear,
}) {
  const { templates, categories, loading, error } = useTemplates();

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer-panel">
        <div className="drawer-header">
          <h3 style={{ margin: 0 }}>Choose a template for {stepLabel}</h3>
          <button type="button" className="secondary small" onClick={onClose}>Close</button>
        </div>

        <div className="drawer-body">
          {loading && <p className="muted">Loading templates...</p>}
          {error && <div className="alert error">{error}</div>}
          {!loading && !error && (
            <TemplateGrid
              templates={templates}
              categories={categories}
              onChoose={onChoose}
              onStartScratch={onClear}
            />
          )}
        </div>
      </div>
    </>
  );
}
