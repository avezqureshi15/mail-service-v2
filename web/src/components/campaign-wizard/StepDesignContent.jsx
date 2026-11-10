import { useState } from 'react';
import { api } from '../../lib/api.js';
import TemplateEditor from '../TemplateEditor.jsx';
import PreviewSidebar from '../PreviewSidebar.jsx';
import TemplateDrawer from './TemplateDrawer.jsx';

/**
 * Step 3: a fixed-height, two-column workspace. The editor and the preview
 * each scroll on their own (see `.wizard-split-col` in styles.css) so the
 * top bar - which sequence step you're on, simple vs HTML mode - never moves
 * out of reach while you're writing.
 */
export default function StepDesignContent({
  steps,
  activeStep,
  setActiveStep,
  addStep,
  removeStep,
  updateStep,
  handleContentChange,
  selectedTemplate,
  lint,
  waitUnit,
  mergeSample,
  mode,
  onModeChange,
}) {
  const step = steps[activeStep];
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Step 2's picker only ever reaches the step that was active when it ran -
  // in practice, step 1. This drawer is how a follow-up added later (or any
  // step you've changed your mind about) gets a template too. It's a
  // separate, imperative path from Step 2's `selectedTemplate` flow in
  // CampaignEditor.jsx - applying here never touches that state, so neither
  // path can interfere with the other.
  async function handleChooseTemplate(templateId) {
    if (step.htmlBody.trim() && !window.confirm(
      `Step ${activeStep + 1} already has content - choosing a new template will replace it. Continue?`,
    )) {
      return;
    }
    const data = await api.get(`/templates/${templateId}`);
    updateStep(activeStep, {
      htmlBody: data.template.content,
      subject: step.subject || (data.template.defaultSubject ?? ''),
    });
    setDrawerOpen(false);
  }

  function handleClearTemplate() {
    if (step.htmlBody.trim() && !window.confirm(
      `Step ${activeStep + 1} already has content - this will clear it. Continue?`,
    )) {
      return;
    }
    updateStep(activeStep, { htmlBody: '' });
    setDrawerOpen(false);
  }

  return (
    <div className="wizard-split">
      <div className="wizard-split-col editor-col">
        <div className="design-topbar">
          <div className="sequence-stepbar">
            {steps.map((_, index) => (
              <button
                key={index}
                type="button"
                className={`step-tab ${index === activeStep ? 'active' : ''}`}
                onClick={() => setActiveStep(index)}
              >
                <span className="num">{index + 1}</span>
                Step {index + 1}{index === 0 ? ' (first touch)' : ''}
              </button>
            ))}
            {steps.length < 10 && (
              <button type="button" className="secondary small" onClick={addStep}>
                + Add follow-up step
              </button>
            )}
            {step && (
              <button type="button" className="secondary small" onClick={() => setDrawerOpen(true)}>
                {step.htmlBody.trim() ? 'Change template' : 'Choose template'}
              </button>
            )}
          </div>

          <div className="editor-mode-toggle">
            <button type="button" className={mode === 'simple' ? 'active' : ''} onClick={() => onModeChange('simple')}>
              Simple
            </button>
            <button type="button" className={mode === 'html' ? 'active' : ''} onClick={() => onModeChange('html')}>
              HTML
            </button>
          </div>
        </div>

        {steps.length > 1 && (
          <div className="alert info">
            Anyone who replies, unsubscribes or bounces is removed from the sequence
            automatically. Follow-ups are threaded onto the first message.
          </div>
        )}

        {step && (
          <>
            {activeStep > 0 && (
              <div className="card">
                <div className="step-head">
                  <strong>Step {activeStep + 1}</strong>
                  <button type="button" className="secondary small" onClick={() => removeStep(activeStep)}>
                    Remove
                  </button>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
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
              </div>
            )}

            <TemplateEditor
              templateId={selectedTemplate}
              currentStep={step}
              onContentChange={handleContentChange}
              mode={mode}
              onModeChange={onModeChange}
              onChooseTemplate={() => setDrawerOpen(true)}
            />
          </>
        )}
      </div>

      <div className="wizard-split-col preview-col">
        <PreviewSidebar lint={lint} step={step} mergeSample={mergeSample} />
      </div>

      {drawerOpen && (
        <TemplateDrawer
          stepLabel={`Step ${activeStep + 1}${activeStep === 0 ? ' (first touch)' : ''}`}
          onClose={() => setDrawerOpen(false)}
          onChoose={handleChooseTemplate}
          onClear={handleClearTemplate}
        />
      )}
    </div>
  );
}
