import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import TemplateSelector from '../components/TemplateSelector.jsx';
import TemplateEditor from '../components/TemplateEditor.jsx';
import TemplatePreview from '../components/TemplatePreview.jsx';
import PreviewSidebar from '../components/PreviewSidebar.jsx';

const BLANK_STEP = { subject: '', htmlBody: '', waitDays: 3 };

export default function CampaignEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);

  const [lists, setLists] = useState([]);
  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState('');
  const [subCategories, setSubCategories] = useState([]);
  const [newSubCategory, setNewSubCategory] = useState('');
  const [addingSubCategory, setAddingSubCategory] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [trackingAvailable, setTrackingAvailable] = useState(false);
  // So the wait field can say "minutes" while sequence testing mode is on,
  // rather than claiming days and sending three minutes later.
  const [waitUnit, setWaitUnit] = useState('days');
  const [form, setForm] = useState({
    name: '',
    listId: '',
    categoryId: '',
    subCategoryId: '',
    fromName: '',
    fromEmail: '',
    replyTo: '',
    trackingEnabled: false,
  });
  const [steps, setSteps] = useState([{ ...BLANK_STEP, waitDays: 0 }]);
  const [lint, setLint] = useState(null);
  const [activeStep, setActiveStep] = useState(0);
  // Read inside the template effect without making it a dependency - as a
  // dependency it would re-apply the template every time the rep switched
  // step, overwriting their edits.
  const activeStepRef = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  // Setup first: the campaign name lives here and Save stays disabled without
  // it, so opening on the Email tab left the button greyed out for a reason
  // the rep could not see.
  const [activeTab, setActiveTab] = useState('setup');
  // Only complain about an empty name once the rep has actually been in the
  // field - a form that is red before you touch it is just noise.
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [listData, dashboard, categoryData] = await Promise.all([
          api.get('/lists'),
          api.get('/dashboard'),
          api.get('/campaigns/categories'),
        ]);
        setLists(listData.lists);
        setTrackingAvailable(dashboard.config.trackingConfigured);
        setWaitUnit(dashboard.sequenceWaitUnit ?? 'days');
        setCategories(categoryData.categories ?? []);
        const defaultCategoryId = (categoryData.categories ?? [])
          .find((c) => c.name.toLowerCase() === 'uncategorised')?.id
          ?? categoryData.categories?.[0]?.id ?? '';

        if (editing) {
          const { campaign } = await api.get(`/campaigns/${id}`);
          const resolvedCategoryId = String(campaign.category_id ?? defaultCategoryId ?? '');
          setForm({
            name: campaign.name,
            listId: campaign.list_id ?? '',
            categoryId: resolvedCategoryId,
            subCategoryId: String(campaign.sub_category_id ?? ''),
            fromName: campaign.from_name ?? '',
            fromEmail: campaign.from_email ?? '',
            replyTo: campaign.reply_to ?? '',
            trackingEnabled: Boolean(campaign.tracking_enabled),
          });
          setSteps(campaign.steps.map((s) => ({
            subject: s.subject,
            htmlBody: s.html_body,
            waitDays: s.wait_days,
          })));

          // Only the sub-categories under this campaign's category are
          // relevant, so the dropdown starts with the right options.
          if (resolvedCategoryId) {
            const subData = await api.get(`/campaigns/subcategories/${resolvedCategoryId}`);
            setSubCategories(subData.subCategories ?? []);
          }
        } else {
          // New campaign: preselect the default category so it always belongs
          // to one from the moment it is created.
          setForm((f) => ({ ...f, categoryId: String(defaultCategoryId) }));
          if (defaultCategoryId) {
            const subData = await api.get(`/campaigns/subcategories/${defaultCategoryId}`);
            setSubCategories(subData.subCategories ?? []);
          }
        }
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [id, editing]);

  // Live content score for the step being edited.
  useEffect(() => {
    const step = steps[activeStep];
    if (!step) return undefined;
    const timer = setTimeout(async () => {
      try {
        setLint(await api.post('/campaigns/lint', {
          subject: step.subject,
          htmlBody: step.htmlBody,
        }));
      } catch {
        setLint(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [steps, activeStep]);

  // A chosen template fills the step currently open, and only that one.
  //
  // This used to fill every empty step with the same design, which suited a
  // set of templates that differed by look. The sequence templates differ by
  // *copy* - a reminder is not an opener - so one template across five steps
  // would send the same message five times with Re: in front of it. Use
  // "Load all steps" in the picker to set up a whole sequence at once.
  useEffect(() => {
    if (!selectedTemplate) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(`/templates/${selectedTemplate}`);
        if (cancelled) return;
        setSteps((current) => current.map((s, i) => (
          i === activeStepRef.current
            ? { ...s, htmlBody: data.template.content, subject: s.subject || (data.template.defaultSubject ?? '') }
            : s
        )));
      } catch {
        // The active step's editor surfaces any load error.
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  /**
   * Replaces the whole campaign with a ready-made sequence.
   *
   * The order, the waits and the first subject come from the templates
   * themselves, so this cannot drift from what the templates intend. Only
   * offered when nothing has been written yet, since it discards content.
   */
  const loadSequence = useCallback((ordered) => {
    setSteps(ordered.map((t, i) => ({
      subject: i === 0 ? (t.defaultSubject ?? '') : '',
      htmlBody: t.content ?? '',
      waitDays: t.sequence?.waitDays ?? 0,
    })));
    setActiveStep(0);
    setSelectedTemplate(ordered[0]?.id ?? null);
  }, []);

  useEffect(() => { activeStepRef.current = activeStep; }, [activeStep]);

  const updateStep = useCallback((index, patch) => {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }, []);

  // Stable identity, so child effects that depend on it do not re-run on
  // every render of this component.
  const handleContentChange = useCallback(
    (content) => updateStep(activeStep, content),
    [updateStep, activeStep],
  );

  function addStep() {
    // Deliberately empty. Cloning step 1 used to keep the design consistent,
    // but it also meant a newly added step was never empty - so picking a
    // template for it silently did nothing.
    setSteps((current) => [...current, { ...BLANK_STEP }]);
    setActiveStep(steps.length);
  }

  function removeStep(index) {
    setSteps((current) => current.filter((_, i) => i !== index));
    setActiveStep((current) => Math.max(0, current - 1));
  }

  // Categories are unique server-side (case-insensitive), so reusing a name
  // returns the existing one and the dropdown selects it either way.
  async function addCategory() {
    const name = newCategory.trim();
    if (!name) return;
    setError('');
    try {
      const { category } = await api.post('/campaigns/categories', { name });
      const data = await api.get('/campaigns/categories');
      setCategories(data.categories ?? []);
      setForm((f) => ({ ...f, categoryId: String(category.id), subCategoryId: '' }));
      setSubCategories([]);
      setNewCategory('');
      setAddingCategory(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // Sub-categories are unique per category server-side, so reusing a name
  // returns the existing one and the dropdown selects it either way.
  async function addSubCategory() {
    const name = newSubCategory.trim();
    if (!name || !form.categoryId) return;
    setError('');
    try {
      const { subCategory } = await api.post('/campaigns/subcategories', {
        name,
        categoryId: Number(form.categoryId),
      });
      const data = await api.get(`/campaigns/subcategories/${form.categoryId}`);
      setSubCategories(data.subCategories ?? []);
      setForm((f) => ({ ...f, subCategoryId: String(subCategory.id) }));
      setNewSubCategory('');
      setAddingSubCategory(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // Switching category invalidates the sub-category: the old one belongs to a
  // different parent, so both the selection and the options are reset.
  async function changeCategory(categoryId) {
    setForm((f) => ({ ...f, categoryId, subCategoryId: '' }));
    setSubCategories([]);
    setAddingSubCategory(false);
    if (!categoryId) return;
    try {
      const data = await api.get(`/campaigns/subcategories/${categoryId}`);
      setSubCategories(data.subCategories ?? []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function save() {
    setError('');
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        listId: form.listId ? Number(form.listId) : null,
        categoryId: form.categoryId ? Number(form.categoryId) : null,
        subCategoryId: form.subCategoryId ? Number(form.subCategoryId) : null,
        subject: steps[0]?.subject ?? '',
        htmlBody: steps[0]?.htmlBody ?? '',
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo,
        trackingEnabled: form.trackingEnabled,
        steps: steps.map((step, index) => ({
          subject: step.subject,
          htmlBody: step.htmlBody,
          waitDays: index === 0 ? 0 : Number(step.waitDays) || 3,
        })),
      };

      const result = editing
        ? await api.put(`/campaigns/${id}`, payload)
        : await api.post('/campaigns', payload);

      navigate(`/campaigns/${result.campaign.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const step = steps[activeStep];

  // What each step still needs, so the tabs can show progress and the Save
  // button's disabled state is explained rather than just greyed out.
  const setupComplete = Boolean(form.name.trim());
  const emailComplete = steps.every((s) => s.subject.trim() && s.htmlBody.trim());

  const selectedList = lists.find((list) => String(list.id) === String(form.listId));

  // Pre-flight checklist shown next to the primary action so reps can see at
  // a glance what still stands between them and a send.
  const checklist = [
    { label: 'Audience list selected', done: Boolean(form.listId) },
    { label: 'Campaign name set', done: setupComplete },
    { label: 'Subject line present', done: steps.every((s) => s.subject.trim()) },
    { label: 'Email body present', done: emailComplete },
    { label: 'Sender address set', done: Boolean(form.fromEmail || form.fromName) },
  ];
  const readyToLaunch = checklist.every((item) => item.done);

  return (
    <>
      {/* Sticky, so Save and Cancel stay reachable however far the email
          form is scrolled. */}
      <div className="page-head sticky">
        <div className="editor-title">
          <h2 style={{ margin: 0 }}>{editing ? 'Edit campaign' : 'New campaign'}</h2>
          <div className="campaign-metrics">
            <span className="metric">
              <span className="metric-label">Audience</span>
              <strong>{selectedList ? `${selectedList.name} (${selectedList.contact_count})` : 'Not selected'}</strong>
            </span>
            <span className={`status-badge ${editing ? 'scheduled' : 'draft'}`}>
              {editing ? 'Editing' : 'Draft'}
            </span>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => navigate('/campaigns')}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy || !setupComplete}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* Pre-flight checklist, kept beside the primary actions. */}
      <div className="card launch-checklist-card">
        <div className="launch-checklist-head">
          <strong>Pre-flight checklist</strong>
          <span className={`status-badge ${readyToLaunch ? 'scheduled' : 'draft'}`}>
            {readyToLaunch ? 'Ready' : 'Incomplete'}
          </span>
        </div>
        <ul className="launch-checklist">
          {checklist.map((item) => (
            <li key={item.label} className={item.done ? 'completed' : 'pending'}>
              <span className="check-icon">{item.done ? '✓' : '○'}</span>
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      {/* Numbered so the order is obvious, and marked so an incomplete step
          is visible from whichever step you are on. */}
      <div className="step-tabs">
        <button
          type="button"
          className={`step-tab ${activeTab === 'setup' ? 'active' : ''} ${setupComplete ? 'done' : 'incomplete'}`}
          onClick={() => setActiveTab('setup')}
        >
          <span className="num">{setupComplete ? '✓' : '1'}</span>
          Setup
        </button>
        <button
          type="button"
          className={`step-tab ${activeTab === 'email' ? 'active' : ''} ${emailComplete ? 'done' : ''}`}
          onClick={() => setActiveTab('email')}
        >
          <span className="num">{emailComplete ? '✓' : '2'}</span>
          Write the email
        </button>
      </div>

      {/* SETUP TAB */}
      {activeTab === 'setup' && (
        <div className="tab-content-setup">
          <div className="card">
            <h3>Campaign Details</h3>
            <div className={`field ${nameTouched && !setupComplete ? 'invalid' : ''}`}>
              <label htmlFor="name">Campaign name <span style={{ color: 'var(--bad)' }}>*</span></label>
              <input
                id="name"
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onBlur={() => setNameTouched(true)}
                placeholder="Internal name, not shown to recipients"
              />
              {nameTouched && !setupComplete
                ? <div className="field-error">Required before the campaign can be saved</div>
                : <div className="hint">Only you and the team see this, never the recipient.</div>}
            </div>
            <div className="field">
              <label htmlFor="list">Contact list</label>
              <select
                id="list"
                value={form.listId}
                onChange={(e) => setForm({ ...form, listId: e.target.value })}
              >
                <option value="">Select a list</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name} ({list.contact_count} contacts)
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="category">Category</label>
              <div className="category-row">
                <select
                  id="category"
                  value={form.categoryId}
                  onChange={(e) => changeCategory(e.target.value)}
                >
                  {categories.length === 0 && <option value="">Loading...</option>}
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => setAddingCategory((open) => !open)}
                >
                  {addingCategory ? 'Cancel' : 'New category'}
                </button>
              </div>
              {addingCategory && (
                <div className="category-row" style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    value={newCategory}
                    maxLength={60}
                    placeholder="e.g. Recruitment"
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); }}
                  />
                  <button
                    type="button"
                    onClick={addCategory}
                    disabled={!newCategory.trim()}
                  >
                    Add
                  </button>
                </div>
              )}
              <div className="hint">Groups campaigns. Names are unique and shared across the team.</div>
            </div>

            <div className="field">
              <label htmlFor="subcategory">Sub-category</label>
              <div className="category-row">
                <select
                  id="subcategory"
                  value={form.subCategoryId}
                  onChange={(e) => setForm({ ...form, subCategoryId: e.target.value })}
                  disabled={!form.categoryId}
                >
                  <option value="">No sub-category</option>
                  {subCategories.map((subCategory) => (
                    <option key={subCategory.id} value={subCategory.id}>
                      {subCategory.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => setAddingSubCategory((open) => !open)}
                  disabled={!form.categoryId}
                >
                  {addingSubCategory ? 'Cancel' : 'New sub-category'}
                </button>
              </div>
              {addingSubCategory && (
                <div className="category-row" style={{ marginTop: 8 }}>
                  <input
                    type="text"
                    value={newSubCategory}
                    maxLength={60}
                    placeholder="e.g. Engineering"
                    onChange={(e) => setNewSubCategory(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addSubCategory(); }}
                  />
                  <button
                    type="button"
                    onClick={addSubCategory}
                    disabled={!newSubCategory.trim()}
                  >
                    Add
                  </button>
                </div>
              )}
              <div className="hint">
                Narrows the category above. Sub-categories belong to the selected category.
              </div>
            </div>


            <h3 style={{ marginTop: 24 }}>Sender Information</h3>
            <div className="row">
              <div className="field">
                <label htmlFor="fromName">From name</label>
                <input
                  id="fromName"
                  type="text"
                  value={form.fromName}
                  onChange={(e) => setForm({ ...form, fromName: e.target.value })}
                  placeholder="Defaults to the service setting"
                />
              </div>
              <div className="field">
                <label htmlFor="replyTo">Reply-to</label>
                <input
                  id="replyTo"
                  type="email"
                  value={form.replyTo}
                  onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
                  placeholder="Where replies should land"
                />
              </div>
            </div>

            <div className="checkbox" style={{ marginTop: 18 }}>
              <input
                id="tracking"
                type="checkbox"
                checked={form.trackingEnabled}
                disabled={!trackingAvailable}
                onChange={(e) => setForm({ ...form, trackingEnabled: e.target.checked })}
              />
              <label htmlFor="tracking">
                Track opens and clicks
                <div className="hint">
                  {trackingAvailable
                    ? 'Off by default. Tracking pixels and rewritten links measurably reduce inbox placement, so leave this off for cold outreach and turn it on only for warmer sends.'
                    : 'Unavailable - TRACKING_DOMAIN is not configured on the server.'}
                </div>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* EMAIL TAB */}
      {activeTab === 'email' && (
        <div className="grid cols-2">
          <div>
            <TemplateSelector
              onLoadSequence={loadSequence}
              onSelect={setSelectedTemplate}
              selectedTemplateId={selectedTemplate}
            />

            <div className="card">
              <div className="step-head">
                <h3 style={{ margin: 0 }}>
                  {steps.length > 1 ? `Sequence (${steps.length} steps)` : 'Message'}
                </h3>
                {steps.length < 10 && (
                  <button type="button" className="secondary small" onClick={addStep}>
                    Add follow-up step
                  </button>
                )}
              </div>

              {steps.length > 1 && (
                <>
                  <div className="preview-tabs">
                    {steps.map((_, index) => (
                      <button
                        key={index}
                        type="button"
                        className={index === activeStep ? 'active' : ''}
                        onClick={() => setActiveStep(index)}
                      >
                        Step {index + 1}
                      </button>
                    ))}
                  </div>
                  <div className="alert info">
                    Anyone who replies, unsubscribes or bounces is removed from the sequence
                    automatically. Follow-ups are threaded onto the first message.
                  </div>
                </>
              )}

              {step && (
                <div className="step">
                  <div className="step-head">
                    <strong>Step {activeStep + 1}{activeStep === 0 ? ' (first touch)' : ''}</strong>
                    {activeStep > 0 && (
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => removeStep(activeStep)}
                      >
                        Remove
                      </button>
                    )}
                  </div>

                  {activeStep > 0 && (
                    <div className="field">
                      <label htmlFor="wait">
                        Send this many {waitUnit === 'minutes' ? 'minutes' : 'days'} after the previous step
                      </label>
                      <input
                        id="wait"
                        type="number"
                        min="1"
                        max="90"
                        value={step.waitDays}
                        onChange={(e) => updateStep(activeStep, { waitDays: e.target.value })}
                      />
                      {waitUnit === 'minutes' && (
                        <div className="field-error">
                          Sequence testing mode is on, so this is counted in minutes. Turn it
                          off in Settings before a real campaign.
                        </div>
                      )}
                    </div>
                  )}

                  <TemplateEditor
                    templateId={selectedTemplate}
                    currentStep={step}
                    onContentChange={handleContentChange}
                  />
                </div>
              )}
            </div>
          </div>

          <PreviewSidebar
            lint={lint}
            step={step}
            mergeSample={{
              first_name: 'John',
              last_name: 'Smith',
              company: 'Acme Corp',
              email: 'john@acme.com',
            }}
          />
        </div>
      )}
    </>
  );
}
