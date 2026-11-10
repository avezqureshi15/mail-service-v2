import { useState } from 'react';

/**
 * Category tabs + 3-col template gallery + "Start from scratch" tile.
 *
 * Shared between Step 2 (the full-page gallery, picking the first touch's
 * template) and the per-step drawer in Design & Content (picking a template
 * for whichever follow-up is open) - same cards, same filtering, one copy.
 */
export default function TemplateGrid({
  templates, categories, onChoose, onStartScratch, onLoadSequence,
}) {
  const [selectedCategory, setSelectedCategory] = useState('all');

  const filtered = selectedCategory === 'all'
    ? templates
    : templates.filter((t) => t.category === selectedCategory);

  // Templates that declare a position in a sequence, in order - meant to be
  // used together as the steps of one campaign, not chosen between.
  const sequence = templates
    .filter((t) => t.sequence)
    .sort((a, b) => a.sequence.step - b.sequence.step);

  return (
    <>
      <div className="category-tabs">
        <button
          type="button"
          className={`secondary small ${selectedCategory === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedCategory('all')}
        >
          All
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`secondary small ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {onLoadSequence && sequence.length > 1 && (
        <div className="sequence-cta">
          <div>
            <strong>These {sequence.length} work as one sequence</strong>
            <span className="muted">
              Loads every step in order with its wait already set. Edit the wording afterwards.
            </span>
          </div>
          <button type="button" onClick={() => onLoadSequence(sequence)}>
            Load all {sequence.length} steps
          </button>
        </div>
      )}

      <div className="template-grid">
        <button type="button" className="template-card-blank" onClick={onStartScratch}>
          <span className="plus">+</span>
          <strong>Start from scratch</strong>
          <span>Write your own HTML, no template</span>
        </button>

        {filtered.map((template) => (
          <button
            key={template.id}
            type="button"
            className="template-card"
            onClick={() => onChoose(template.id)}
          >
            <div className="template-thumb"><Thumbnail html={template.content} /></div>
            <div className="template-body">
              <div className="template-name">{template.name}</div>
              <div className="template-desc">{template.description}</div>
              <div className="template-tags">
                {(template.bestFor ?? []).slice(0, 2).map((use) => (
                  <span key={use} className="tag">{use}</span>
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>

      {filtered.length === 0 && <p className="muted">No templates in this category.</p>}
    </>
  );
}

/**
 * Template HTML is untrusted content, so it renders in a sandboxed frame with
 * no script execution and no access to this origin.
 */
function Thumbnail({ html }) {
  return (
    <iframe
      title="Template preview"
      sandbox=""
      scrolling="no"
      srcDoc={html}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
