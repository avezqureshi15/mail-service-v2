import { useTemplates } from '../../lib/useTemplates.js';
import TemplateGrid from './TemplateGrid.jsx';

/**
 * Step 2: a full-page gallery rather than a picker embedded above the editor
 * - template, sequence or blank is one decision, made once, before any
 * writing starts. Choosing one (or starting from scratch) advances the
 * wizard immediately; there is nothing else to do on this screen.
 */
export default function StepTemplateSelection({ onChooseTemplate, onLoadSequence, onStartScratch }) {
  const { templates, categories, loading, error } = useTemplates();

  if (loading) return <div className="wizard-page-inner"><p className="muted">Loading templates...</p></div>;
  if (error) return <div className="wizard-page-inner"><div className="alert error">{error}</div></div>;

  return (
    <div className="wizard-page-inner" style={{ maxWidth: 960 }}>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        Pick a design to start from. You can edit all the wording afterwards.
      </p>

      <TemplateGrid
        templates={templates}
        categories={categories}
        onChoose={onChooseTemplate}
        onStartScratch={onStartScratch}
        onLoadSequence={onLoadSequence}
      />
    </div>
  );
}
