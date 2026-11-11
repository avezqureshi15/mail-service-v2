/**
 * Step 1: everything needed before there is any copy to write - what the
 * campaign is called, who it's from, the first subject/preheader, and who
 * it's going to. Category and tracking are real settings too, just secondary
 * ones, so they sit lower on the page rather than competing with the fields
 * above.
 */
export default function StepSetupAudience({
  form,
  setForm,
  nameTouched,
  setNameTouched,
  setupComplete,
  firstStep,
  onFirstStepChange,
  lists,
  categories,
  subCategories,
  newCategory,
  setNewCategory,
  addingCategory,
  setAddingCategory,
  addCategory,
  newSubCategory,
  setNewSubCategory,
  addingSubCategory,
  setAddingSubCategory,
  addSubCategory,
  changeCategory,
  trackingAvailable,
  mailboxes,
}) {
  const selectedList = lists.find((list) => String(list.id) === String(form.listId));
  const selectedMailbox = mailboxes.find((m) => String(m.id) === String(form.mailboxId));

  return (
    <div className="wizard-page-inner">
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
          <label htmlFor="subject">Subject line</label>
          <input
            id="subject"
            type="text"
            value={firstStep.subject}
            onChange={(e) => onFirstStepChange({ subject: e.target.value })}
            placeholder="Question about {{company}}"
          />
          <div className="hint">What the recipient sees as the email's subject.</div>
        </div>

        <div className="field">
          <label htmlFor="preheader">Preheader text</label>
          <input
            id="preheader"
            type="text"
            maxLength={150}
            value={firstStep.preheader}
            onChange={(e) => onFirstStepChange({ preheader: e.target.value })}
            placeholder="The preview text shown after the subject in most inboxes"
          />
          <div className="hint">Shown in the inbox list, right after the subject. Kept short - most clients cut it off.</div>
        </div>
      </div>

      <div className="card">
        <h3>Audience</h3>
        <div className="field" style={{ marginBottom: selectedList ? 10 : 14 }}>
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
        {selectedList && (
          <div className="review-summary">
            <div className="item">
              <div className="label">Subscribers</div>
              <div className="value">{selectedList.contact_count}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Sender Information</h3>
        <div className="row">
          <div className="field">
            <label htmlFor="fromName">Sender name</label>
            <input
              id="fromName"
              type="text"
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              placeholder="Defaults to the service setting"
            />
          </div>
          <div className="field">
            <label htmlFor="mailbox">Send from <span style={{ color: 'var(--bad)' }}>*</span></label>
            <select
              id="mailbox"
              value={form.mailboxId}
              onChange={(e) => setForm({ ...form, mailboxId: e.target.value })}
            >
              <option value="">Select a mailbox</option>
              {mailboxes.map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.label} ({mailbox.from_email})
                </option>
              ))}
            </select>
            {mailboxes.length === 0 ? (
              <div className="field-error">
                No sending mailboxes yet. Add one under Settings &rsaquo; Mailboxes.
              </div>
            ) : (
              <div className="hint">
                Every message in this campaign, follow-ups included, goes out of this
                account and is paced against its own daily limit.
                {selectedMailbox?.fromMustMatchUser && (
                  <> {selectedMailbox.providerLabel} sends only as{' '}
                  {selectedMailbox.from_email}, so the sender address can&rsquo;t be
                  overridden per campaign.</>
                )}
              </div>
            )}
          </div>
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

      <div className="card">
        <h3>Organization</h3>
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
      </div>
    </div>
  );
}
