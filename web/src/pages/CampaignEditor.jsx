import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import WizardHeader from '../components/campaign-wizard/WizardHeader.jsx';
import WizardStepper from '../components/campaign-wizard/WizardStepper.jsx';
import StepSetupAudience from '../components/campaign-wizard/StepSetupAudience.jsx';
import StepTemplateSelection from '../components/campaign-wizard/StepTemplateSelection.jsx';
import StepDesignContent from '../components/campaign-wizard/StepDesignContent.jsx';
import StepReviewSend from '../components/campaign-wizard/StepReviewSend.jsx';

const BLANK_STEP = {
  subject: '', preheader: '', htmlBody: '', waitDays: 3,
};

export default function CampaignEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const editing = Boolean(id);

  // A fresh campaign starts locked to step 1; an existing draft already has
  // data in every step, so there is nothing to gate - any step is reachable
  // from the moment it loads.
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(editing ? 4 : 1);
  // Set when "Start from scratch" is chosen in step 2, so step 2 counts as
  // answered without a template id to point to.
  const [fromScratch, setFromScratch] = useState(false);
  // Lifted out of TemplateEditor so step 3's top bar can show it next to the
  // sequence step tabs instead of duplicating it inside the editor card.
  const [mode, setMode] = useState('simple');
  const [blockers, setBlockers] = useState([]);

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
  // Gmail only accepts a From address that is the authenticated mailbox
  // itself or one of its verified aliases - a per-campaign override would
  // just fail (or get silently rewritten) at send time, so the wizard shows
  // this read-only rather than letting it be typed.
  const [configuredFromAddress, setConfiguredFromAddress] = useState('');
  const [form, setForm] = useState({
    name: '',
    listId: '',
    categoryId: '',
    subCategoryId: '',
    fromName: '',
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
        setConfiguredFromAddress(dashboard.config?.fromAddress ?? '');
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
            replyTo: campaign.reply_to ?? '',
            trackingEnabled: Boolean(campaign.tracking_enabled),
          });
          setSteps(campaign.steps.map((s) => ({
            subject: s.subject,
            preheader: s.preheader ?? '',
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
  // would send the same message five times with Re: in front of it. Choosing
  // "Load all steps" in step 2 sets up a whole sequence at once instead.
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
      preheader: '',
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

  function buildPayload() {
    return {
      name: form.name,
      listId: form.listId ? Number(form.listId) : null,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      subCategoryId: form.subCategoryId ? Number(form.subCategoryId) : null,
      subject: steps[0]?.subject ?? '',
      preheader: steps[0]?.preheader ?? '',
      htmlBody: steps[0]?.htmlBody ?? '',
      fromName: form.fromName,
      // Always empty: Gmail only accepts the configured mailbox (or a
      // verified alias) as the From address, so there is no per-campaign
      // override to send - compose.js falls back to env.MAIL_FROM_ADDRESS.
      fromEmail: '',
      replyTo: form.replyTo,
      trackingEnabled: form.trackingEnabled,
      steps: steps.map((step, index) => ({
        subject: step.subject,
        preheader: step.preheader,
        htmlBody: step.htmlBody,
        waitDays: index === 0 ? 0 : Number(step.waitDays) || 3,
      })),
    };
  }

  // Saves and stays on the editor, so a wizard in progress is never
  // interrupted by a jump to the detail page. A brand-new campaign switches
  // the URL to its edit route (so later saves go through PUT), without
  // losing wizard state - that lives in this component, not the route.
  async function saveDraft() {
    setError('');
    setBusy(true);
    try {
      const payload = buildPayload();
      const result = editing
        ? await api.put(`/campaigns/${id}`, payload)
        : await api.post('/campaigns', payload);
      toast.success(editing ? 'Draft saved' : 'Campaign created');
      if (!editing) {
        navigate(`/campaigns/${result.campaign.id}/edit`, { replace: true });
      }
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setError('');
    setBlockers([]);
    setBusy(true);
    try {
      const payload = buildPayload();
      const result = editing
        ? await api.put(`/campaigns/${id}`, payload)
        : await api.post('/campaigns', payload);
      await api.post(`/campaigns/${result.campaign.id}/start`);
      toast.success('Campaign started sending');
      navigate(`/campaigns/${result.campaign.id}`);
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
      if (err.details) setBlockers(err.details);
    } finally {
      setBusy(false);
    }
  }

  function goNext() {
    setCurrentStep((current) => {
      const next = Math.min(4, current + 1);
      setMaxStepReached((max) => Math.max(max, next));
      return next;
    });
  }

  function goPrev() {
    setCurrentStep((current) => Math.max(1, current - 1));
  }

  function jumpTo(stepId) {
    setCurrentStep((current) => (stepId <= maxStepReached ? stepId : current));
  }

  function onChooseTemplate(templateId) {
    setSelectedTemplate(templateId);
    setFromScratch(false);
    goNext();
  }

  function onLoadSequenceChoice(ordered) {
    loadSequence(ordered);
    goNext();
  }

  function onStartScratch() {
    setSelectedTemplate(null);
    setFromScratch(true);
    goNext();
  }

  const firstStep = steps[0] ?? BLANK_STEP;
  const setupComplete = Boolean(form.name.trim());
  // A follow-up step with no subject of its own inherits the first touch's
  // (see compose.js's `step.subject || campaign.subject`) - that's the normal
  // shape of a real sequence, not an incomplete one, so only step 0's subject
  // is required. Every step still needs its own body - there's no reason a
  // step would deliberately want to resend step 1's content verbatim.
  const emailComplete = steps.every((s, i) => s.htmlBody.trim() && (i > 0 || s.subject.trim()));
  const step1Complete = setupComplete;
  const step2Complete = Boolean(selectedTemplate) || fromScratch;
  const step3Complete = emailComplete;

  const selectedList = lists.find((list) => String(list.id) === String(form.listId));

  const checklist = [
    { label: 'Audience list selected', done: Boolean(form.listId) },
    { label: 'Campaign name set', done: setupComplete },
    { label: 'Subject line present', done: Boolean(firstStep.subject.trim()) },
    { label: 'Email body present', done: emailComplete },
  ];
  const readyToLaunch = checklist.every((item) => item.done);

  const continueDisabled = currentStep === 1 ? !step1Complete
    : currentStep === 2 ? !step2Complete
      : currentStep === 3 ? !step3Complete
        : false;

  return (
    <div className="wizard-shell">
      <WizardHeader
        campaignName={form.name}
        onBack={() => navigate('/campaigns')}
        onSaveDraft={saveDraft}
        saving={busy}
        showPrevious={currentStep > 1}
        onPrevious={goPrev}
        showContinue={currentStep < 4}
        onContinue={goNext}
        continueDisabled={continueDisabled}
      />
      <WizardStepper currentStep={currentStep} maxStepReached={maxStepReached} onJump={jumpTo} />

      <div className="wizard-body">
        {currentStep === 1 && (
          <div className="wizard-page">
            {error && <div className="alert error" style={{ marginBottom: 16, maxWidth: 760 }}>{error}</div>}
            <StepSetupAudience
              form={form}
              setForm={setForm}
              nameTouched={nameTouched}
              setNameTouched={setNameTouched}
              setupComplete={setupComplete}
              firstStep={firstStep}
              onFirstStepChange={(patch) => updateStep(0, patch)}
              lists={lists}
              categories={categories}
              subCategories={subCategories}
              newCategory={newCategory}
              setNewCategory={setNewCategory}
              addingCategory={addingCategory}
              setAddingCategory={setAddingCategory}
              addCategory={addCategory}
              newSubCategory={newSubCategory}
              setNewSubCategory={setNewSubCategory}
              addingSubCategory={addingSubCategory}
              setAddingSubCategory={setAddingSubCategory}
              addSubCategory={addSubCategory}
              changeCategory={changeCategory}
              trackingAvailable={trackingAvailable}
              configuredFromAddress={configuredFromAddress}
            />
          </div>
        )}

        {currentStep === 2 && (
          <div className="wizard-page">
            {error && <div className="alert error" style={{ marginBottom: 16 }}>{error}</div>}
            <StepTemplateSelection
              onChooseTemplate={onChooseTemplate}
              onLoadSequence={onLoadSequenceChoice}
              onStartScratch={onStartScratch}
            />
          </div>
        )}

        {currentStep === 3 && (
          <StepDesignContent
            steps={steps}
            activeStep={activeStep}
            setActiveStep={setActiveStep}
            addStep={addStep}
            removeStep={removeStep}
            updateStep={updateStep}
            handleContentChange={handleContentChange}
            selectedTemplate={selectedTemplate}
            lint={lint}
            waitUnit={waitUnit}
            mergeSample={{
              first_name: 'John',
              last_name: 'Smith',
              company: 'Acme Corp',
              email: 'john@acme.com',
            }}
            mode={mode}
            onModeChange={setMode}
          />
        )}

        {currentStep === 4 && (
          <div className="wizard-page">
            <StepReviewSend
              form={form}
              firstStep={firstStep}
              selectedList={selectedList}
              configuredFromAddress={configuredFromAddress}
              checklist={checklist}
              readyToLaunch={readyToLaunch}
              busy={busy}
              error={error}
              blockers={blockers}
              onSaveDraft={saveDraft}
              onSendNow={sendNow}
            />
          </div>
        )}
      </div>
    </div>
  );
}
