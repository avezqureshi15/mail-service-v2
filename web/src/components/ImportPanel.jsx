import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

/**
 * Three-step import: pick a destination list, preview shows the validation
 * report, commit writes it. The destination is chosen up front so the rep
 * never uploads a file before deciding where it goes.
 */
export default function ImportPanel({ lists, currentListId, onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [destMode, setDestMode] = useState(
    currentListId || lists.length > 0 ? 'existing' : 'new',
  );
  const [existingListId, setExistingListId] = useState(
    currentListId || (lists[0] ? String(lists[0].id) : ''),
  );
  const [newListName, setNewListName] = useState('');
  const [includeFlagged, setIncludeFlagged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const destListName = destMode === 'existing'
    ? (lists.find((list) => String(list.id) === String(existingListId))?.name ?? '')
    : newListName.trim();

  async function runPreview(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const result = await api.importPreview(file);
      setPreview(result);
      if (destMode === 'new' && !newListName) setNewListName(file.name.replace(/\.csv$/i, ''));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setError('');
    if (!destListName) {
      setError('Choose a list to import into.');
      return;
    }
    setBusy(true);
    try {
      const contacts = includeFlagged
        ? [...preview.payload.accepted, ...preview.payload.flagged]
        : preview.payload.accepted;

      if (contacts.length === 0) {
        setError('Nothing to import.');
        return;
      }
      const result = await api.post('/contacts/import/commit', { listName: destListName, includeFlagged: true, contacts });
      toast.success(`Imported ${result.imported} contact(s) into "${result.list.name}"`);
      onDone();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const labels = preview?.reasonLabels ?? {};

  return (
    <div className="card">
      <div className="step-head">
        <strong>Import contacts from CSV</strong>
        <button type="button" className="secondary small" onClick={onClose}>Close</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="field">
        <label>Import into</label>
        <div className="actions" style={{ marginBottom: 8 }}>
          <label style={{ fontWeight: 400, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="radio"
              name="destMode"
              style={{ width: 'auto' }}
              checked={destMode === 'existing'}
              disabled={lists.length === 0}
              onChange={() => setDestMode('existing')}
            />
            An existing list
          </label>
          <label style={{ fontWeight: 400, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="radio"
              name="destMode"
              style={{ width: 'auto' }}
              checked={destMode === 'new'}
              onChange={() => setDestMode('new')}
            />
            A new list
          </label>
        </div>

        {destMode === 'existing' ? (
          lists.length > 0 ? (
            <select value={existingListId} onChange={(e) => setExistingListId(e.target.value)}>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.contact_count})
                </option>
              ))}
            </select>
          ) : (
            <div className="hint">No lists yet - create one below.</div>
          )
        ) : (
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="e.g. Q4 Prospects"
          />
        )}
      </div>

      {!preview ? (
        <>
          <div className="field">
            <label htmlFor="csv">CSV file</label>
            <input id="csv" type="file" accept=".csv,text/csv" ref={fileRef} onChange={runPreview} />
            <div className="hint">
              Needs an email column. Name, company and any extra columns are picked up
              automatically and become merge fields.
            </div>
          </div>
          {busy && <p className="muted">Validating addresses and checking domains...</p>}
        </>
      ) : (
        <>
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <Stat label="Accepted" value={preview.summary.accepted} tone="good" />
            <Stat label="Flagged" value={preview.summary.flagged} tone="warn" />
            <Stat label="Rejected" value={preview.summary.rejected} tone="bad" />
          </div>

          {preview.flagged.length > 0 && (
            <Bucket
              title="Flagged - review before including"
              rows={preview.flagged}
              labels={labels}
              tone="warn"
            />
          )}
          {preview.rejected.length > 0 && (
            <Bucket
              title="Rejected - not imported"
              rows={preview.rejected}
              labels={labels}
              tone="bad"
            />
          )}

          {preview.summary.flagged > 0 && (
            <div className="checkbox field">
              <input
                id="flagged"
                type="checkbox"
                checked={includeFlagged}
                onChange={(e) => setIncludeFlagged(e.target.checked)}
              />
              <label htmlFor="flagged">
                Also import the {preview.summary.flagged} flagged address(es)
                <div className="hint">
                  Shared mailboxes like info@ and sales@ complain more often than personal
                  addresses. Including them raises your complaint rate.
                </div>
              </label>
            </div>
          )}

          <div className="actions">
            <button type="button" onClick={commit} disabled={busy || !destListName}>
              {busy ? 'Importing...' : `Import ${includeFlagged
                ? preview.summary.accepted + preview.summary.flagged
                : preview.summary.accepted} contact(s)${destListName ? ` into "${destListName}"` : ''}`}
            </button>
            <button type="button" className="secondary" onClick={() => setPreview(null)}>
              Choose a different file
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Bucket({ title, rows, labels, tone }) {
  const grouped = rows.reduce((acc, row) => {
    (acc[row.reason] ??= []).push(row);
    return acc;
  }, {});

  return (
    <div className={`alert ${tone}`} style={{ marginBottom: 14 }}>
      <strong>{title}</strong>
      <ul>
        {Object.entries(grouped).map(([reason, items]) => (
          <li key={reason}>
            <strong>{items.length}</strong> &mdash; {labels[reason] ?? reason}
            <div className="mono" style={{ opacity: .8 }}>
              {items.slice(0, 4).map((i) => i.email).join(', ')}
              {items.length > 4 ? ` and ${items.length - 4} more` : ''}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={{ color: `var(--${tone})` }}>{value}</div>
    </div>
  );
}
