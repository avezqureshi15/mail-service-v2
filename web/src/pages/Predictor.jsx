import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import Banner from '../components/Banner.jsx';
import FloatingField from '../components/FloatingField.jsx';

// LOW reads as "still usable, just less certain" rather than "wrong" - a red
// pill on a third of the table read as errors, not confidence levels.
const BAND_CLASS = { high: 'good', medium: 'warn', low: 'neutral' };

export default function Predictor() {
  const [mode, setMode] = useState('single');
  const [stats, setStats] = useState(null);
  const [nameModel, setNameModel] = useState(false);

  async function loadStats() {
    try {
      const { stats: s, nameModel: on } = await api.get('/predictor/stats');
      setStats(s);
      setNameModel(Boolean(on));
    } catch {
      // The headline counts are decoration; the page works without them.
    }
  }

  useEffect(() => { loadStats(); }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Email Predictor</h2>
          <p>
            {stats
              ? `${stats.companies_known} companies known, ${stats.formats_proven} formats proven by delivery.`
              : 'Work out a prospect\'s address from one address you already know at their company.'}
          </p>
        </div>
        <span className={`badge ${nameModel ? 'good' : 'neutral'}`} title={nameModel
          ? 'Awkward names are sent to the model to settle which word is the surname and what short forms a mailbox might use.'
          : 'Set LLM_API_KEY to have a model help with awkward names. Everything else works without it.'}>
          name model {nameModel ? 'on' : 'off'}
        </span>
      </div>

      <div className="tab-navigation" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`tab-nav-button${mode === 'single' ? ' active' : ''}`}
          onClick={() => setMode('single')}
        >
          One company
        </button>
        <button
          type="button"
          className={`tab-nav-button${mode === 'bulk' ? ' active' : ''}`}
          onClick={() => setMode('bulk')}
        >
          Upload a file
        </button>
      </div>

      {mode === 'single'
        ? <SingleCompany onSaved={loadStats} />
        : <BulkUpload onSaved={loadStats} />}
    </>
  );
}

/* -------------------------------------------------------------- one company */

function SingleCompany({ onSaved }) {
  const [domain, setDomain] = useState('');
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [seedEmail, setSeedEmail] = useState('');
  const [seedOwnerName, setSeedOwnerName] = useState('');
  const [names, setNames] = useState('');
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Answering "do we already know this company?" while they type is the
  // whole payoff - when we do, they never see the seed fields at all.
  useEffect(() => {
    const value = domain.trim();
    if (!value) { setInfo(null); return undefined; }

    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        setInfo(await api.post('/predictor/domain', { domain: value }));
      } catch {
        setInfo(null);
      } finally {
        setChecking(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [domain]);

  const known = Boolean(info?.known);
  const nameList = names.split('\n').map((n) => n.split('\t')[0].trim()).filter(Boolean);
  const estSeconds = Math.max(1, Math.round(Math.min(nameList.length, 40) * 2.5));

  async function run() {
    setError('');
    setBusy(true);
    try {
      const data = await api.post('/predictor/predict', {
        domain: domain.trim(),
        names: nameList,
        seedEmail: seedEmail.trim(),
        seedOwnerName: seedOwnerName.trim(),
        checkAllNames: true,
      });
      setOutcome(data);
      if (data.learnedNow) {
        setInfo(data);
        onSaved();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <FloatingField
          id="pred-domain"
          label="Company website"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="apex.com"
          hint="Paste the website straight from your sheet - a full URL is fine."
        />

        {checking && <p className="muted">Checking...</p>}

        {info?.blocked && (
          <Banner type="warning" dismissible={false}>{info.blockedLabel}</Banner>
        )}

        {known && (
          <FormatStatusCard info={info} />
        )}

        {!known && info && !info.blocked && (
          <Banner type="info">
            We have not seen <span className="mono">{info.domain}</span> before. Give us one
            address that works there and we will learn the format - once only, then never again.
          </Banner>
        )}
      </div>

      {!known && (
        <div className="card">
          <div className="form-grid cols-2">
            <FloatingField
              id="pred-seed"
              label="One working address there"
              value={seedEmail}
              onChange={(e) => setSeedEmail(e.target.value)}
              placeholder="priya.nair@apex.com"
              hint="Not info@ or sales@ - a shared mailbox follows no personal format."
            />
            <FloatingField
              id="pred-seed-owner"
              label="Whose address is it?"
              value={seedOwnerName}
              onChange={(e) => setSeedOwnerName(e.target.value)}
              placeholder="Priya Nair"
              hint="Their real name. Do not read it off the address - we would just learn back your guess."
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="field">
          <label htmlFor="pred-names">
            People you want
            <span className="counter-badge" style={{ marginLeft: 8 }}>{nameList.length}</span>
          </label>
          <textarea
            id="pred-names"
            rows={8}
            value={names}
            placeholder={'Rajesh Kumar Sharma\nMike (Michael) Chen\nDr. Priyamvada Kaushik'}
            onChange={(e) => setNames(e.target.value)}
          />
          <p className="hint">
            One name per line. Paste a column straight out of your spreadsheet - job titles,
            emoji and pronouns are stripped automatically.
          </p>
        </div>

        <div className="feature-card">
          <div className="feature-card-icon" aria-hidden="true">&#10024;</div>
          <div className="feature-card-body">
            <label className="feature-card-toggle">
              <input type="checkbox" checked disabled readOnly />
              <span className="feature-card-title">Check every name with the model</span>
            </label>
            <p className="feature-card-copy">
              Worth it when word order is the question: the plain reading takes the last word
              as the surname, which is wrong for many South Indian, Chinese and Korean names.
            </p>
            <span className="badge neutral">~{estSeconds}s for this list</span>
          </div>
        </div>

        <button
          type="button"
          disabled={busy || nameList.length === 0 || !domain.trim() || (!known && !seedEmail.trim())}
          onClick={run}
        >
          {busy ? 'Working...' : `Predict ${nameList.length || ''} ${nameList.length === 1 ? 'address' : 'addresses'}`}
        </button>
      </div>

      {outcome && <Results outcome={outcome} onSaved={onSaved} />}
    </>
  );
}

/** Compact "format known" status card - replaces a paragraph of prose with
 * one line and a confidence pill, so skimming a dozen domains in a row does
 * not mean reading a dozen sentences. */
function FormatStatusCard({ info }) {
  const proven = info.provenance === 'proven';
  return (
    <div className="status-card">
      <span className="status-card-icon" aria-hidden="true">&#10003;</span>
      <div className="status-card-body">
        <strong>
          Format known: <span className="mono">{info.pattern}</span>
        </strong>
        <span className={`badge ${proven ? 'good' : 'warn'}`}>
          {proven ? 'Confirmed by delivery' : 'Unconfirmed'}
        </span>
        {info.example && (
          <div className="status-card-example">
            Example: <span className="mono">{info.example}</span>
          </div>
        )}
        <div className="status-card-example">No seed needed. Just add names below.</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- bulk */

function BulkUpload({ onSaved }) {
  const fileRef = useRef(null);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function upload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError('');
    setBusy(true);
    try {
      setOutcome(await api.predictorBulk(file));
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h3>Upload a list</h3>
        <Banner type="tip">
          <a href="/mail-predictor-template.csv" download>Download the CSV template</a>
          {' '}and fill it in. One seed per company is enough - put it on any one row and
          leave it blank on the rest. Companies we already know need no seed at all.
          <br />
          The example rows use <span className="mono">.example</span> domains, so they are
          harmless if you forget to delete them - they simply fail the mail-server check.
        </Banner>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={upload} disabled={busy} />
        {busy && <p className="muted">Reading the file...</p>}
      </div>

      {outcome && (
        <>
          <div className="card">
            <h3>By company</h3>
            <p className="muted">
              {outcome.rows} rows, {outcome.companies} companies,
              {' '}{outcome.companiesLearned} format{outcome.companiesLearned === 1 ? '' : 's'} learned
              from this file.
            </p>

            {outcome.probing > 0 && (
              <Banner type="info" dismissible={false}>
                <strong>
                  {outcome.heldBack} {outcome.heldBack === 1 ? 'person is' : 'people are'} held
                  back across {outcome.probing} unconfirmed
                  {outcome.probing === 1 ? ' company' : ' companies'}.
                </strong>
                <br />
                Each of those companies released one person. Mail them, and the rest unlock
                as soon as something lands or bounces - a format nobody has confirmed is a
                claim, and fifty addresses built on a wrong one is fifty bounces.
                {outcome.rollouts?.length > 0 && (
                  <ul>
                    {outcome.rollouts.slice(0, 6).map((r) => (
                      <li key={r.domain}>
                        <span className="mono">{r.domain}</span> - {r.heldPeople} held
                      </li>
                    ))}
                  </ul>
                )}
              </Banner>
            )}

            {outcome.rejectedSeeds?.length > 0 && (
              <Banner type="warning" dismissible={false}>
                {outcome.rejectedSeeds.length} seed
                {outcome.rejectedSeeds.length === 1 ? '' : 's'} could not be used:
                <ul>
                  {outcome.rejectedSeeds.slice(0, 8).map((s) => (
                    <li key={s.domain}>
                      <span className="mono">{s.seedEmail}</span> - {s.label}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}

            <div className="table-wrap">
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Company</th><th>High</th><th>Medium</th><th>Low</th>
                    <th>Skipped</th><th>Needs a seed</th>
                  </tr>
                </thead>
                <tbody>
                  {outcome.byCompany.map((row) => (
                    <tr key={row.domain}>
                      <td className="mono" data-label="Company">{row.domain}</td>
                      <td data-label="High">{row.high}</td>
                      <td data-label="Medium">{row.medium}</td>
                      <td data-label="Low">{row.low}</td>
                      <td data-label="Skipped">{row.skipped}</td>
                      <td data-label="Needs a seed">
                        {row.needsSeed
                          ? <span className="badge warn">one address unlocks this company</span>
                          : <span className="muted">--</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Results outcome={outcome} onSaved={onSaved} />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------- results */

function Results({ outcome, onSaved }) {
  const toast = useToast();
  const usable = (outcome.results ?? []).filter((r) => !r.suppressed);
  const [picked, setPicked] = useState(() => new Set(
    usable.filter((r) => r.band !== 'low').map((r) => r.email),
  ));
  // Forces the dismissible banners below back open on every new run - a
  // dismissed "8 in 10 are exact" tip from the last batch should not hide a
  // fresh rollout warning this batch actually needs.
  const [runId, setRunId] = useState(0);

  /**
   * A second prediction run replaces every row, but `picked` is state and
   * survives it - so the ticks would still refer to addresses from the
   * previous run. The button then reads "Add 5 to contacts" while the
   * selection matches nothing on screen, and posts an empty list.
   */
  useEffect(() => {
    setPicked(new Set(usable.filter((r) => r.band !== 'low').map((r) => r.email)));
    setSaved(null);
    setError('');
    setRunId((id) => id + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  const [lists, setLists] = useState([]);
  // '' = contacts only, '__new' = create one, otherwise an existing list id.
  const [listChoice, setListChoice] = useState('');
  const [newListName, setNewListName] = useState('');
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectAllRef = useRef(null);

  async function loadLists() {
    try {
      const { lists: found } = await api.get('/lists');
      setLists(found ?? []);
    } catch {
      // Falling back to "create a new one" is still a usable path.
    }
  }

  useEffect(() => { loadLists(); }, []);

  // Derived from the rows actually on screen, never from `picked` alone, so
  // the count on the button is always the count that would be posted.
  const chosen = usable.filter((r) => picked.has(r.email));
  const allPicked = usable.length > 0 && usable.every((r) => picked.has(r.email));
  const somePicked = chosen.length > 0 && !allPicked;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = somePicked;
  }, [somePicked]);

  const toggle = (email) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(usable.map((r) => r.email)));

  async function save() {
    if (chosen.length === 0) {
      setError('Nothing is selected.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const result = await api.post('/predictor/save', {
        listName: listChoice === '__new' ? newListName.trim() : '',
        ...(listChoice && listChoice !== '__new' ? { listId: Number(listChoice) } : {}),
        contacts: chosen.map((r) => ({
          email: r.email,
          firstName: r.firstName,
          lastName: r.lastName,
          company: r.company ?? '',
          customFields: Object.fromEntries(
            [['observation', r.observation], ['role_examples', r.roleExamples]]
              .filter(([, v]) => v),
          ),
        })),
      });
      setSaved({ count: result.saved, listId: result.listId });
      toast.success(`Saved ${result.saved} contact${result.saved === 1 ? '' : 's'}.`);
      // A list may have just been created, and the picker should show it.
      await loadLists();
      if (result.listId) setListChoice(String(result.listId));
      onSaved();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const missingMergeFields = chosen.some((r) => !r.observation || !r.roleExamples);
  const duplicateListName = listChoice === '__new'
    && lists.some((l) => l.name.toLowerCase() === newListName.trim().toLowerCase());

  return (
    <div className="card">
      <div className="table-head-row">
        <h3 style={{ margin: 0 }}>Predicted addresses</h3>
        {usable.length > 0 && <span className="badge neutral">{chosen.length} selected</span>}
      </div>

      {outcome.rollout?.probe && (
        <Banner key={`rollout-${runId}`} type="warning" dismissible={false}>
          <strong>
            {outcome.rollout.state === 'disputed'
              ? 'An address at this company bounced, and nothing has landed yet.'
              : 'Nothing has confirmed this company\'s format yet.'}
          </strong>
          <br />
          {outcome.rollout.nextAction}
          {outcome.rollout.heldAlternatives > 0 && (
            <>
              {' '}The other {outcome.rollout.heldAlternatives} possible
              address{outcome.rollout.heldAlternatives === 1 ? '' : 'es'} for this person
              {outcome.rollout.heldAlternatives === 1 ? ' is' : ' are'} held back too -
              trying several at one company is what receiving servers treat as an attack.
            </>
          )}
        </Banner>
      )}

      {error && <div className="alert error">{error}</div>}
      {saved && (
        <Banner key={`saved-${runId}`} type="success">
          Saved {saved.count} contact{saved.count === 1 ? '' : 's'}
          {saved.listId
            ? <> to <strong>{lists.find((l) => l.id === saved.listId)?.name ?? 'the list'}</strong>.</>
            : ', not added to any list.'}
        </Banner>
      )}

      {outcome.namesEnriched > 0 && (
        <Banner key={`enriched-${runId}`} type="tip">
          {outcome.namesEnriched} awkward name{outcome.namesEnriched === 1 ? ' was' : 's were'}
          {' '}checked by the model for word order and short forms (marked &#10024; below). Where
          it disagreed with the plain reading, both appear - the model&apos;s first.
        </Banner>
      )}

      {usable.length === 0 ? (
        <div className="empty">Nothing could be predicted from this input.</div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="rtable">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      ref={selectAllRef}
                      checked={allPicked}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th>Name</th><th>Predicted address</th><th>Confidence</th><th>Also possible</th>
                </tr>
              </thead>
              <tbody>
                {usable.map((row) => (
                  <tr key={row.email}>
                    <td className="select-cell">
                      <input
                        type="checkbox"
                        checked={picked.has(row.email)}
                        onChange={() => toggle(row.email)}
                        aria-label={`Select ${row.email}`}
                      />
                    </td>
                    <td data-label="Name">
                      {row.inputName}
                      {row.nameSource === 'model' && (
                        <span
                          className="model-indicator"
                          title="This name's word order was settled by the AI model rather than the plain last-word rule."
                        >
                          &#10024;
                        </span>
                      )}
                    </td>
                    <td className="mono" data-label="Address">{row.email}</td>
                    <td data-label="Confidence"><span className={`badge ${BAND_CLASS[row.band]}`}>{row.band}</span></td>
                    <td className="mono muted" data-label="Also possible">
                      {row.alternatives?.length
                        ? row.alternatives.map((a) => a.email).join(', ')
                        : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sticky-action-bar">
            <div className="row" style={{ margin: 0 }}>
              <select
                value={listChoice}
                aria-label="Add to list"
                onChange={(e) => setListChoice(e.target.value)}
              >
                <option value="">Contacts only - no list</option>
                {lists.length > 0 && (
                  <optgroup label="Add to an existing list">
                    {lists.map((list) => (
                      <option key={list.id} value={String(list.id)}>
                        {list.name} ({list.contact_count})
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__new">+ Create a new list...</option>
              </select>

              {listChoice === '__new' && (
                <input
                  value={newListName}
                  placeholder="e.g. Q1 Outreach - Apex"
                  autoFocus
                  onChange={(e) => setNewListName(e.target.value)}
                />
              )}

              <button
                type="button"
                disabled={
                  busy
                  || chosen.length === 0
                  || (listChoice === '__new' && !newListName.trim())
                }
                onClick={save}
              >
                {busy ? 'Saving...' : `Add ${chosen.length} to contacts`}
              </button>
            </div>

            {duplicateListName && (
              <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
                A list called <strong>{newListName.trim()}</strong> already exists - these
                contacts will be added to it rather than a second one being created.
              </p>
            )}
          </div>

          {missingMergeFields && (
            <Banner key={`merge-${runId}`} type="warning">
              Some of these have no observation or role_examples. The outreach sequence will
              refuse to start until every contact has both - fill those columns in the upload
              template, or edit the contacts before sending.
            </Banner>
          )}

          <Banner key={`advice-${runId}`} type="tip">
            Roughly 8 in 10 predictions are exact. Do not send a whole new company at once -
            mail two people, wait a day, and send the rest once those land.
          </Banner>
        </>
      )}

      {outcome.skipped?.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Skipped ({outcome.skipped.length})</h3>
          <div className="table-wrap">
            <table className="rtable">
              <thead><tr><th>Name</th><th>Company</th><th>Why</th></tr></thead>
              <tbody>
                {outcome.skipped.slice(0, 50).map((row, i) => (
                  <tr key={`${row.name}-${i}`}>
                    <td data-label="Name">{row.name || '--'}</td>
                    <td className="mono" data-label="Company">{row.domain || '--'}</td>
                    <td className="muted" data-label="Why">{row.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
