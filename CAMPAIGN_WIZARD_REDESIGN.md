# Campaign Wizard Redesign - Progress & Handoff

Redesigning `/campaigns/new` (and `/campaigns/:id/edit`) from the current
2-tab editor into a 4-step wizard (Setup & Audience -> Template Selection ->
Design & Content -> Review & Send), per the user's spec. This doc exists so
work can resume cleanly if the session runs out of context.

**Status: feature-complete and browser-tested end to end.** Everything in
"Remaining plan" below is done. Kept for context on *why* things are built
the way they are - read "Decisions already made" and "Found during testing"
before changing any of this.

## Decisions already made (do not re-ask these)

1. **Styling**: extend the existing plain-CSS `styles.css` class system
   (`.card`, `--accent`, etc). No Tailwind, no CSS Modules - user chose this
   explicitly to match the rest of the app.
2. **Preheader field**: build *real* backend support (DB column + compose
   pipeline), not just a decorative input - user chose this explicitly.
3. **Scheduled send**: explicitly OUT of scope. Step 4 only gets "Save Draft"
   and "Send Campaign Now" (immediate start via existing `/campaigns/:id/start`).
   The `scheduled_at` column/`scheduled` status already exist in the DB but no
   worker honors them - leave that gap alone unless asked again.
4. **Subject editing**: Step 1 edits the *first* step's subject (acts as the
   campaign-level subject, mirroring existing `steps[0]` convention). Step 3's
   `TemplateEditor` **keeps its own per-step subject input unchanged** so
   follow-up steps can still override their subject - this is real existing
   sequence functionality and must not regress.
5. **Preheader editing**: lives ONLY in Step 1, editing `steps[0].preheader`.
   Not exposed per-step in `TemplateEditor`/Step 3, even though the DB column
   exists per-step (for symmetry with subject, and future-proofing). Follow-up
   steps simply inherit the campaign/step-1 preheader via the
   `step.preheader || campaign.preheader` fallback already written into
   `compose.js`.
6. `TemplateEditor.jsx`'s Simple/HTML `mode` was converted from internal
   `useState` to controlled props (`mode`, `onModeChange`) because Step 3's
   spec puts that toggle in a shared top bar together with the sequence step
   tabs, outside `TemplateEditor`'s own card.
7. `TemplateSelector.jsx` and `CampaignHeader.jsx` are now **dead code** (fully
   superseded by `StepTemplateSelection.jsx` and `WizardHeader.jsx`) - delete
   them, don't leave them orphaned. Confirmed nothing else imports either.
8. `CampaignEditor.jsx` keeps its filename and route (`/campaigns/new` and
   `/campaigns/:id/edit` both still point at it) - rewritten in place rather
   than renamed, to avoid touching `App.jsx` routing.

## Done

### Backend - real `preheader` support

- **`server/src/db/migrations/002_add_preheader.sql`** (new): adds
  `preheader TEXT NOT NULL DEFAULT ''` to both `campaigns` and
  `sequence_steps`. **Not yet applied to any running database** - run
  `npm run migrate` (in `server/`) before this feature can work end-to-end.
- **`server/src/db/repositories/campaigns.js`**: `createCampaign()` accepts
  `preheader`; `UPDATABLE` set includes `'preheader'`; `replaceSteps()` inserts
  it per step.
- **`server/src/routes/campaigns.js`**: `stepSchema`/`campaignSchema` (zod)
  both have `preheader` (max 150 chars); POST `/` and PUT `/:id` pass it
  through; `buildSteps()` propagates it per step (same fallback pattern as
  subject: a step's own value wins, else step 0 falls back to the
  campaign-level value).
- **`server/src/mail/compose.js`**: new `buildPreheader(text)` builds a
  hidden, padded preview-text `<div>`; `composeMessage()` renders merge
  fields into `step.preheader || campaign.preheader` and prepends it to the
  HTML (before tracking is applied, after the footer is appended).
- **`server/test/compose.test.js`**: 3 new tests (injected with merge fields,
  step-level override wins, no markup when neither is set). **All 16 tests in
  this file pass** (`node --test test/compose.test.js` from `server/`).

### Frontend - in progress

- **`web/src/styles.css`**: appended a full "Campaign wizard" section at the
  end - `.wizard-shell`/`.wizard-header`/`.wizard-stepper`/`.wizard-page` (the
  100vh shell + independently-scrolling regions), `.template-card-blank` +
  `.category-tabs` (Step 2), `.wizard-split`/`.design-topbar`/
  `.sequence-stepbar`/`.editor-mode-toggle` (Step 3's split workspace),
  `.review-summary`/`.review-grid`/`.review-card`/`.action-footer` (Step 4).
- **`web/src/components/campaign-wizard/WizardHeader.jsx`** (new): sticky top
  bar - back link, campaign name + Draft badge, Save Draft, Previous/Continue.
- **`web/src/components/campaign-wizard/WizardStepper.jsx`** (new): the
  4-segment progress bar. Exports `WIZARD_STEPS`. A step is clickable once
  `maxStepReached >= step.id` (lets you go back freely, not skip ahead).
- **`web/src/components/campaign-wizard/StepSetupAudience.jsx`** (new): Step 1
  - campaign name, subject line, preheader (edits `firstStep`/`steps[0]` via
  `onFirstStepChange`), audience list dropdown + subscriber count, sender
  name/email (email input was previously missing from the UI despite being in
  the data model and actually used by `compose.js` - this fixes that gap),
  reply-to, tracking toggle, category/sub-category management.
- **`web/src/components/campaign-wizard/StepTemplateSelection.jsx`** (new):
  Step 2 - category tabs, "Start from scratch" tile + 3-col template grid
  (reuses `.template-grid`/`.template-card` styles), the "load all N as a
  sequence" CTA. Calls `onChooseTemplate`/`onLoadSequence`/`onStartScratch`,
  all of which the wizard container should make auto-advance to Step 3.
- **`web/src/components/TemplateEditor.jsx`** (edited): removed internal
  `mode` state and its header toggle buttons; now takes `mode`/`onModeChange`
  as props (set by the wizard container, rendered in Step 3's shared top bar
  instead). Everything else (subject input per step, simple/HTML body editor,
  merge-field chips, collapsible sections) is unchanged.

## Remaining plan

1. **`web/src/components/campaign-wizard/StepDesignContent.jsx`** (not
   started): Step 3's 2-column split.
   - Top bar (`.design-topbar`): sequence step tabs (reuse `.step-tabs`/
     `.step-tab` styling, "Step N (first touch)" / "+ Add follow-up step") on
     the left, Simple/HTML mode toggle (`.editor-mode-toggle`) on the right.
   - Left column (`.wizard-split-col.editor-col`): wait-days input for
     steps > 0 (existing logic), then `<TemplateEditor>` with `mode`/
     `onModeChange` passed through, remove-step button.
   - Right column (`.wizard-split-col.preview-col`): `<PreviewSidebar>`
     unchanged (already has Preview/Health-check tabs and the desktop/mobile
     device toggle inside `TemplatePreview`).
   - Wrap both in `<div className="wizard-split">` - do **not** wrap this in
     `.wizard-page`/`.wizard-page-inner` (those are for steps 1/2/4 only); the
     split columns scroll independently via `.wizard-split-col`'s own
     `overflow-y: auto`.
2. **`web/src/components/campaign-wizard/StepReviewSend.jsx`** (not started):
   Step 4.
   - A read-only summary row (`.review-summary`): campaign name, subject,
     audience list, sender.
   - Checklist as cards (`.review-grid`/`.review-card`, `done`/`pending`
     modifier classes) covering the same five items the old
     `launch-checklist` tracked: audience selected, name set, subject present,
     body present, sender set.
   - `.action-footer`: "Save Draft" (secondary) and "Send Campaign Now"
     (primary, disabled until the checklist is all `done`). No date/time
     picker - see decision #3 above.
   - Surface `error`/`blockers` (lint blockers from `/start`) the same way
     `CampaignDetail.jsx`'s `act()` does.
3. **Rewrite `web/src/pages/CampaignEditor.jsx`** as the wizard container /
   state machine. Keep almost all existing data-fetching and step-management
   logic from the current file, plus:
   - New state: `currentStep` (1-4, default 1), `maxStepReached` (default 1;
     set to 4 immediately when `editing` is true, since an existing draft's
     data is already there to jump around in), `fromScratch` (bool, for Step
     2's "start from scratch" path), `mode` (`'simple'`/`'html'`, lifted up
     for `TemplateEditor`).
   - `BLANK_STEP` needs `preheader: ''` added.
   - The initial load effect (fetch lists/dashboard/categories, and if
     `editing` also the campaign + its steps) needs `preheader: s.preheader ?? ''`
     added to the steps mapping.
   - `loadSequence()` needs `preheader: ''` added to each mapped step (the
     template manifest has no preheader data, so this is just so the field
     exists for controlled inputs).
   - Refactor `save()`'s payload construction into a `buildPayload()` helper
     that includes `preheader: steps[0]?.preheader ?? ''` at the top level and
     `preheader: step.preheader` per step - reused by two new functions:
     - `saveDraft()`: POST (if new) or PUT (if editing), then **stay on the
       page** - for a brand-new campaign, `navigate(`/campaigns/${id}/edit`, { replace: true })`
       so subsequent saves go through PUT; do **not** jump to the detail page
       (unlike the old `save()`, which always navigated away - that's wrong
       for a wizard where "Save Draft" should let you keep working).
     - `sendNow()`: same save, then `api.post(`/campaigns/${id}/start`)`, then
       `navigate(`/campaigns/${id}`)` (the detail page) - mirrors
       `CampaignDetail.jsx`'s `act()` for surfacing `err.details` as blockers.
   - Step completion gates: `step1Complete = Boolean(form.name.trim())`;
     `step2Complete = Boolean(selectedTemplate) || fromScratch`;
     `step3Complete = steps.every(s => s.subject.trim() && s.htmlBody.trim())`
     (same as the old `emailComplete`).
   - `onChooseTemplate(id)`: `setSelectedTemplate(id); setFromScratch(false);`
     then advance to step 3 (and bump `maxStepReached`).
   - `onLoadSequence(ordered)`: call existing `loadSequence(ordered)` then
     advance to step 3.
   - `onStartScratch()`: `setSelectedTemplate(null); setFromScratch(true);`
     then advance to step 3.
   - Render: `<div className="wizard-shell">` containing `<WizardHeader>`,
     `<WizardStepper>`, then `<div className="wizard-body">` holding either
     `<div className="wizard-page"><div className="wizard-page-inner">...</div></div>`
     (steps 1, 2, 4) or `<StepDesignContent>` directly (step 3, which supplies
     its own `.wizard-split`).
4. **Delete** `web/src/components/TemplateSelector.jsx` and
   `web/src/components/CampaignHeader.jsx` (both superseded, both already
   confirmed unused elsewhere once the rewrite lands).
5. **Browser-test** via the `run` skill or `preview_start`/dev server:
   - New campaign end-to-end: Step 1 validation, Step 2 grid/"start from
     scratch"/"load sequence", Step 3's split-scroll layout at full height
     with live preview + device toggle + mode toggle + add/remove follow-up
     steps, Step 4 checklist + Save Draft + Send Now.
   - Edit an existing draft (`/campaigns/:id/edit`): confirm `maxStepReached`
     unlocks all steps immediately and loaded data (including `preheader`)
     populates correctly.
   - Check responsive/narrow-width behavior isn't broken (not a hard
     requirement from the spec, but don't regress it).
6. **Run the migration** against whatever dev DB is actually reachable before
   testing Save/Send end-to-end (`npm run migrate` in `server/`) - the new
   `preheader` column does not exist on any running database yet.

## Found during testing (fixed)

Browser-testing the real golden path - Step 1 -> Step 2 -> "Load all 5 steps"
-> Step 3 -> Step 4 - surfaced one real regression, now fixed in
`CampaignEditor.jsx`:

- **Per-step subject gating blocked the primary sequence path.** 4 of the 5
  real sequence templates deliberately leave their subject blank (they
  inherit the first touch's subject via `compose.js`'s
  `step.subject || campaign.subject` fallback - this is normal, intended
  shape for a sequence, not incomplete data). The first draft of
  `step3Complete`/`emailComplete` required *every* step to have a non-blank
  subject, which made the Continue button on Step 3, and the "Send Campaign
  Now" button on Step 4, permanently unreachable for the one-click "Load all
  5 steps" flow - the exact path the UI steers people toward. Fixed to only
  require step 0's subject; every step (including follow-ups) still needs its
  own body, since there's no legitimate reason to send a follow-up with
  nothing written in it. See the comment above `emailComplete` in
  `CampaignEditor.jsx`.

Also confirmed (so these aren't mistaken for bugs in a future session):
- Step 3's two columns really do scroll independently - verified via
  `scrollTop`, not just visually (the Browser tool's synthetic wheel-scroll
  has its own coordinate quirks unrelated to the app).
- `/api/lists` legitimately returns zero lists in this environment; the
  empty "Select a list" dropdown is real data, not a fetch failure.
- Ran the full flow against the real Supabase dev DB (migration applied,
  verified `preheader` round-trips through `POST /campaigns`, `PUT`, and the
  real `/campaigns/:id/preview` endpoint - the rendered hidden preview-text
  div had merge fields resolved correctly). Test draft campaigns created
  during this were deleted afterward. **`Send Campaign Now` / `/start` was
  never clicked** - the background `sender` worker is wired to real Gmail
  SMTP, so an actual send was avoided throughout.

## Open/skipped items (deliberately not doing these)

- No changes to `TEMPLATE_FEATURE.md` / `SEQUENCE_PLAYBOOK.md` docs - not
  required by the task, revisit only if those docs turn out to describe the
  old 2-tab UI in a way that's now actively misleading.
- No per-step preheader UI (see decision #5).
- No real scheduled-send worker (see decision #3).
