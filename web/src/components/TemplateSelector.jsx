import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Template picker.
 *
 * Shows a scaled render of each template rather than a written description,
 * because people choose a design by looking at it. Once one is chosen the
 * grid collapses to a single row - seven full-height cards between the top of
 * the page and the editor is most of a screen of scrolling on every visit.
 */
export default function TemplateSelector({ onSelect, selectedTemplateId }) {
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [templatesData, categoriesData] = await Promise.all([
          api.get('/templates?withContent=1'),
          api.get('/templates/categories'),
        ]);
        setTemplates(templatesData.templates);
        setCategories(categoriesData.categories);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selected = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const showGrid = expanded || !selected;

  const filtered = selectedCategory === 'all'
    ? templates
    : templates.filter((t) => t.category === selectedCategory);

  function choose(id) {
    onSelect(id);
    setExpanded(false);
  }

  if (loading) return <div className="card"><p className="muted">Loading templates...</p></div>;
  if (error) return <div className="card"><div className="alert error">{error}</div></div>;

  return (
    <div className="card">
      <div className="step-head">
        <h3 style={{ margin: 0 }}>Email template</h3>
        {selected && (
          <button type="button" className="secondary small" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Cancel' : 'Change template'}
          </button>
        )}
      </div>

      {selected && !expanded && (
        <div className="template-chosen">
          <div className="thumb"><Thumbnail html={selected.content} /></div>
          <div className="meta">
            <strong>{selected.name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{selected.description}</span>
          </div>
        </div>
      )}

      {showGrid && (
        <>
          {!selected && (
            <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
              Pick a design to start from. You can edit all the wording afterwards.
            </p>
          )}

          <div className="field" style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
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
          </div>

          <div className="template-grid">
            {filtered.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`template-card ${selectedTemplateId === template.id ? 'selected' : ''}`}
                onClick={() => choose(template.id)}
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
      )}
    </div>
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
