import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import ImportPanel from '../components/ImportPanel.jsx';

export default function Lists() {
  const navigate = useNavigate();
  const toast = useToast();
  const [lists, setLists] = useState([]);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [listData, statsData] = await Promise.all([
        api.get('/lists'),
        api.get('/contacts/stats'),
      ]);
      setLists(listData.lists);
      setCounts(statsData.counts);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function createList() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.post('/lists', { name });
      toast.success(`Created list "${name}"`);
      setNewName('');
      setCreating(false);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

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
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setCreating(true)}>New list</button>
          <button type="button" onClick={() => setImporting(true)}>Import CSV</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {creating && (
        <div className="card">
          <div className="step-head">
            <strong>New list</strong>
            <button
              type="button"
              className="secondary small"
              onClick={() => { setCreating(false); setNewName(''); }}
            >
              Close
            </button>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="List name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createList(); }}
            />
            <button type="button" onClick={createList} disabled={busy || !newName.trim()}>
              {busy ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {importing && (
        <ImportPanel
          lists={lists}
          onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); load(); }}
        />
      )}

      <div className="template-grid">
        <button type="button" className="template-card" onClick={() => navigate('/contacts/all')}>
          <div className="template-body">
            <div className="template-name">All contacts</div>
            <div className="template-desc">Every contact across every list.</div>
            <span className="badge neutral">{counts.total ?? 0} contacts</span>
          </div>
        </button>
        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            className="template-card"
            onClick={() => navigate(`/contacts/${list.id}`)}
          >
            <div className="template-body">
              <div className="template-name">{list.name}</div>
              {list.description && <div className="template-desc">{list.description}</div>}
              <span className="badge neutral">{list.contact_count} contacts</span>
            </div>
          </button>
        ))}
      </div>

      {lists.length === 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          No lists yet - import a CSV or create one above to get started.
        </p>
      )}
    </>
  );
}
