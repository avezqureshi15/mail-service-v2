import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

export default function Contacts() {
  const [contacts, setContacts] = useState([]);
  const [counts, setCounts] = useState({});
  const [lists, setLists] = useState([]);
  const [search, setSearch] = useState('');
  const [listId, setListId] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  async function load() {
    try {
      const params = new URLSearchParams({ search, limit: '100' });
      if (listId) params.set('listId', listId);
      const [contactData, listData] = await Promise.all([
        api.get(`/contacts?${params}`),
        api.get('/lists'),
      ]);
      setContacts(contactData.contacts);
      setCounts(contactData.counts);
      setLists(listData.lists);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [search, listId]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Contacts</h2>
          <p>
            {counts.active ?? 0} active, {counts.unsubscribed ?? 0} unsubscribed,
            {' '}{counts.bounced ?? 0} bounced.
          </p>
        </div>
        <button type="button" onClick={() => setImporting(true)}>Import CSV</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {importing && (
        <ImportPanel
          lists={lists}
          onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); load(); }}
        />
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <input
            type="search"
            placeholder="Search name, email or company"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">All lists</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.contact_count})
              </option>
            ))}
          </select>
        </div>

        {contacts.length === 0 ? (
          <div className="empty">No contacts match.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th><th>Name</th><th>Company</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td className="mono">
                      {contact.email}
                      {Boolean(contact.is_role_account) && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>role</span>
                      )}
                    </td>
                    <td>{[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '--'}</td>
                    <td>{contact.company || '--'}</td>
                    <td>
                      <span className={`badge ${contact.status === 'active' ? 'good' : 'bad'}`}>
                        {contact.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Two-step import: preview shows the validation report, commit writes it.
 * The rep sees list quality before anything is mailed.
 */
function ImportPanel({ onClose, onDone }) {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [listName, setListName] = useState('');
  const [includeFlagged, setIncludeFlagged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function runPreview(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const result = await api.importPreview(file);
      setPreview(result);
      if (!listName) setListName(file.name.replace(/\.csv$/i, ''));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setError('');
    setBusy(true);
    try {
      const contacts = includeFlagged
        ? [...preview.payload.accepted, ...preview.payload.flagged]
        : preview.payload.accepted;

      if (contacts.length === 0) {
        setError('Nothing to import.');
        return;
      }
      const result = await api.post('/contacts/import/commit', { listName, includeFlagged: true, contacts });
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

          <div className="field">
            <label htmlFor="listName">Add to list</label>
            <input
              id="listName"
              type="text"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="e.g. Q4 Prospects"
            />
            <div className="hint">An existing list with this name is reused.</div>
          </div>

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
            <button type="button" onClick={commit} disabled={busy || !listName.trim()}>
              {busy ? 'Importing...' : `Import ${includeFlagged
                ? preview.summary.accepted + preview.summary.flagged
                : preview.summary.accepted} contact(s)`}
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
