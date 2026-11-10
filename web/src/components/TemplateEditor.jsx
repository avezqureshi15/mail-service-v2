import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import {
  extractFields, applyFieldEdits, extractLinks, applyLinkEdits,
} from '../lib/template-text.js';
import MergeFieldInput from './MergeFieldInput.jsx';

const MERGE_FIELDS = ['first_name', 'last_name', 'company', 'email'];

/**
 * Subject and body editor for one campaign step.
 *
 * Defaults to a plain-text view: the templates are full HTML documents with
 * a few hundred lines of CSS above the first sentence, and a salesperson
 * should never have to go looking for the words in that. The raw HTML stays
 * available behind a toggle.
 *
 * Holds no copy of the content - it reads from `currentStep` and reports
 * edits upward, so switching step always shows that step's text.
 *
 * Simple/HTML mode is a controlled prop rather than local state: the wizard's
 * Design & Content step shows that toggle in its own top bar, shared with the
 * sequence step tabs, rather than duplicating it inside this card.
 */
export default function TemplateEditor({
  templateId, onContentChange, currentStep, mode, onModeChange, onChooseTemplate,
}) {
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const subject = currentStep?.subject ?? '';
  const htmlBody = currentStep?.htmlBody ?? '';

  const subjectRef = useRef(null);

  // Held in refs so the fetch effect does not depend on either identity.
  // Depending on onContentChange meant: fetch -> notify parent -> re-render
  // -> new function -> fetch again, which hammered the API into a 429.
  // htmlBody is read fresh at fetch time (see below) rather than put in the
  // dependency array, since typing in the body must not re-trigger a fetch.
  const notify = useRef(onContentChange);
  useEffect(() => {
    notify.current = onContentChange;
  });
  const htmlBodyRef = useRef(htmlBody);
  useEffect(() => {
    htmlBodyRef.current = htmlBody;
  });

  useEffect(() => {
    if (!templateId) {
      setTemplate(null);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    (async () => {
      try {
        const data = await api.get(`/templates/${templateId}`);
        if (cancelled) return;
        setTemplate(data.template);
        // CampaignEditor already seeds every empty step with this same
        // template and leaves steps that already have wording alone, so this
        // step's body must be left untouched here too - otherwise switching
        // templates after writing a step's copy would silently wipe it,
        // fighting the very guarantee CampaignEditor is giving the rep.
        if (!htmlBodyRef.current || !htmlBodyRef.current.trim()) {
          notify.current({ htmlBody: data.template.content });
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [templateId]);

  const fields = useMemo(() => extractFields(htmlBody), [htmlBody]);
  const links = useMemo(() => extractLinks(htmlBody), [htmlBody]);

  /**
   * Links are matched to the field that carries their text, so a missing
   * destination is flagged beside the button a rep is actually reading
   * rather than in a list further down the page.
   */
  const linkByFieldText = useMemo(() => {
    const map = new Map();
    for (const link of links) {
      if (link.text && link.text !== '(no text)') map.set(link.text, link);
    }
    return map;
  }, [links]);

  const sections = useMemo(() => {
    const order = ['Header', 'Body', 'Footer'];
    const grouped = new Map();
    for (const field of fields) {
      if (!grouped.has(field.section)) grouped.set(field.section, []);
      grouped.get(field.section).push(field);
    }
    return [...grouped.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [fields]);

  function insertMergeField(name) {
    subjectRef.current?.insertToken(`{{${name}}}`);
  }

  if (loading) {
    return <div className="card"><p className="muted">Loading template...</p></div>;
  }

  const missingLinks = links.filter((l) => l.isPlaceholder).length;

  return (
    <div className="card">
      {error && <div className="alert error">Could not load the template: {error}</div>}

      <div className="field">
        <label htmlFor="subject">Subject line</label>
        <MergeFieldInput
          id="subject"
          ref={subjectRef}
          value={subject}
          onChange={(value) => onContentChange({ subject: value })}
          placeholder="Question about {{company}}"
        />
        <div className="chips">
          {MERGE_FIELDS.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMergeField(name)}
            >
              + {`{{${name}}}`}
            </button>
          ))}
        </div>
      </div>

      {mode === 'html' ? (
        <div className="field">
          <label htmlFor="body">Body (HTML)</label>
          <textarea
            id="body"
            rows={18}
            value={htmlBody}
            onChange={(e) => onContentChange({ htmlBody: e.target.value })}
            placeholder={'<p>Hi {{first_name}},</p>\n<p>...</p>'}
          />
        </div>
      ) : (
        <SimpleEditor
          htmlBody={htmlBody}
          sections={sections}
          links={links}
          linkByFieldText={linkByFieldText}
          missingLinks={missingLinks}
          collapsed={collapsed}
          onToggleSection={(name) => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
          onEditField={(i, v) => onContentChange({ htmlBody: applyFieldEdits(htmlBody, { [i]: v }) })}
          onEditLink={(i, v) => onContentChange({ htmlBody: applyLinkEdits(htmlBody, { [i]: v }) })}
          onSwitchToHtml={() => onModeChange('html')}
          onChooseTemplate={onChooseTemplate}
        />
      )}

      <p className="hint" style={{ marginTop: 14 }}>
        The unsubscribe link and your postal address are added to every message
        automatically - they are not editable, so a campaign cannot go out
        without them.
      </p>
    </div>
  );
}

function SimpleEditor({
  htmlBody, sections, links, linkByFieldText, missingLinks,
  collapsed, onToggleSection, onEditField, onEditLink, onSwitchToHtml, onChooseTemplate,
}) {
  if (!htmlBody.trim()) {
    return (
      <div className="empty">
        <button type="button" onClick={onChooseTemplate}>Choose a template</button>
        {' '}or{' '}
        <button type="button" className="secondary small" onClick={onSwitchToHtml}>
          write the HTML yourself
        </button>
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <div className="alert warn">
        No editable text found. Use the HTML view to edit this content directly.
      </div>
    );
  }

  // Links with no matching text field would otherwise have nowhere to appear.
  const orphanLinks = links.filter((l) => !linkByFieldText.has(l.text) || l.text === '(no text)');

  return (
    <>
      <p className="hint" style={{ marginTop: 4, marginBottom: 14 }}>
        Edit the wording below. The design, layout and colours stay as they are.
      </p>

      {missingLinks > 0 && (
        <div className="alert warn">
          {missingLinks === 1 ? 'One link has' : `${missingLinks} links have`} no destination yet.
          {' '}Look for the <strong>no link set</strong> markers below.
        </div>
      )}

      {sections.map(([section, items]) => {
        const isOpen = !collapsed[section];
        return (
          <div key={section} className="section-block">
            <button
              type="button"
              className={`section-head ${isOpen ? 'open' : ''}`}
              onClick={() => onToggleSection(section)}
              aria-expanded={isOpen}
            >
              <span className="chevron">&#9654;</span>
              {section}
              <span className="count">{items.length} field{items.length === 1 ? '' : 's'}</span>
            </button>

            {isOpen && (
              <div className="section-body">
                {items.map((field) => (
                  <FieldInput
                    key={field.index}
                    field={field}
                    link={linkByFieldText.get(field.text)}
                    onEditField={onEditField}
                    onEditLink={onEditLink}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {orphanLinks.length > 0 && (
        <div className="section-block">
          <div className="section-head open" style={{ cursor: 'default' }}>Other links</div>
          <div className="section-body">
            {orphanLinks.map((link) => (
              <div className="field" key={link.index}>
                <label htmlFor={`l-${link.index}`}>
                  {link.text}
                  {link.isPlaceholder && <span className="badge warn" style={{ marginLeft: 8 }}>no link set</span>}
                </label>
                <input
                  id={`l-${link.index}`}
                  type="url"
                  defaultValue={link.isPlaceholder ? '' : link.href}
                  placeholder="https://webknot.in/..."
                  onBlur={(e) => onEditLink(link.index, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** One field, plus its destination URL where the text is a link. */
function FieldInput({ field, link, onEditField, onEditLink }) {
  return (
    <div className={`field ${link?.isPlaceholder ? 'invalid' : ''}`}>
      <label htmlFor={`f-${field.index}`}>
        {field.label}
        {link?.isPlaceholder && <span className="badge warn" style={{ marginLeft: 8 }}>no link set</span>}
      </label>

      <MergeFieldInput
        id={`f-${field.index}`}
        multiline={field.multiline}
        value={field.text}
        onBlur={(value) => onEditField(field.index, value)}
      />

      {link && (
        <>
          <input
            type="url"
            defaultValue={link.isPlaceholder ? '' : link.href}
            placeholder="Where should this link go? https://webknot.in/..."
            onBlur={(e) => onEditLink(link.index, e.target.value)}
            style={{ marginTop: 6 }}
          />
          {link.isPlaceholder && (
            <div className="field-error">
              Recipients clicking this currently go nowhere.
            </div>
          )}
        </>
      )}
    </div>
  );
}
