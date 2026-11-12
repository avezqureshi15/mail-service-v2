import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import ImportPanel from '../components/ImportPanel.jsx';

const statusFilters = [
  { key: 'all', label: 'All', countKey: 'total' },
  { key: 'active', label: 'Active', countKey: 'active' },
  { key: 'unsubscribed', label: 'Unsubscribed', countKey: 'unsubscribed' },
  { key: 'bounced', label: 'Bounced', countKey: 'bounced' },
];

export default function Lists() {
  const navigate = useNavigate();
  const toast = useToast();
  const [lists, setLists] = useState([]);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState('');
  const [deleting, setDeleting] = useState('');
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

  const searchTerm = search.trim().toLowerCase();
  const visibleLists = lists.filter((list) => {
    const statusCount = statusFilter === 'all'
      ? Number(list.contact_count)
      : Number(list[`${statusFilter}_count`]);
    return (statusFilter === 'all' || statusCount > 0)
      && list.name.toLowerCase().includes(searchTerm);
  });
  const showAllContacts = !searchTerm || 'all contacts'.includes(searchTerm);

  async function exportContacts(list = null) {
    const exportKey = list ? String(list.id) : 'all';
    setExporting(exportKey);
    try {
      const contacts = [];
      let offset = 0;
      let total = 0;
      do {
        const params = new URLSearchParams({ limit: '200', offset: String(offset) });
        if (list) params.set('listId', String(list.id));
        const page = await api.get(`/contacts?${params}`);
        contacts.push(...page.contacts);
        total = page.total;
        if (page.contacts.length === 0) break;
        offset += page.contacts.length;
      } while (offset < total);

      const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
      const rows = [
        ['email', 'first_name', 'last_name', 'company', 'status'],
        ...contacts.map((contact) => [
          contact.email, contact.first_name, contact.last_name, contact.company, contact.status,
        ]),
      ];
      const csv = rows.map((row) => row.map(quote).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(list?.name ?? 'all-contacts').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${contacts.length} contact(s)`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExporting('');
    }
  }

  async function deleteList(list) {
    if (!window.confirm(`Delete list "${list.name}"? Contacts stay - they are just removed from this list.`)) return;
    setDeleting(String(list.id));
    try {
      await api.del(`/lists/${list.id}`);
      toast.success(`Deleted list "${list.name}"`);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeleting('');
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Contacts</h2>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setCreating(true)}>New list</button>
          <button type="button" onClick={() => setImporting(true)}>Import CSV</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {creating && (
        <ContactsDrawer
          title="New list"
          onClose={() => { setCreating(false); setNewName(''); }}
        >
          <div className="field">
            <label htmlFor="new-list-name">List name</label>
            <input
              id="new-list-name"
              type="text"
              placeholder="List name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createList(); }}
            />
          </div>
          <div className="actions">
            <button type="button" onClick={createList} disabled={busy || !newName.trim()}>
              {busy ? 'Creating...' : 'Create'}
            </button>
          </div>
        </ContactsDrawer>
      )}

      {importing && (
        <ContactsDrawer title="Import contacts from CSV" onClose={() => setImporting(false)}>
          <ImportPanel
            lists={lists}
            embedded
            onDone={() => { setImporting(false); load(); }}
          />
        </ContactsDrawer>
      )}

      <div className="contacts-filters" role="group" aria-label="Filter contacts by status">
        {statusFilters.map((filter) => (
          <button
            key={filter.key}
            type="button"
            aria-pressed={statusFilter === filter.key}
            className={`contacts-filter${statusFilter === filter.key ? ' active' : ''}`}
            onClick={() => setStatusFilter(filter.key)}
          >
            {filter.label} <span>({counts[filter.countKey] ?? 0})</span>
          </button>
        ))}
      </div>

      <div className="contacts-list-toolbar">
        <input
          type="search"
          aria-label="Search lists or contacts"
          placeholder="Search lists or contacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="card contacts-list-card">
        {showAllContacts && (
          <ContactListRow
            name="All contacts"
            description="Every contact across every list."
            count={counts[statusFilter === 'all' ? 'total' : statusFilter] ?? 0}
            exporting={exporting === 'all'}
            onView={() => navigate('/contacts/all')}
            onExport={() => exportContacts()}
          />
        )}
        {visibleLists.map((list) => (
          <ContactListRow
            key={list.id}
            name={list.name}
            description={list.description}
            count={statusFilter === 'all' ? list.contact_count : list[`${statusFilter}_count`]}
            exporting={exporting === String(list.id)}
            deleting={deleting === String(list.id)}
            onView={() => navigate(`/contacts/${list.id}`)}
            onExport={() => exportContacts(list)}
            onDelete={() => deleteList(list)}
          />
        ))}
        {!showAllContacts && visibleLists.length === 0 && (
          <div className="empty">No lists match your search or status filter.</div>
        )}
        {showAllContacts && visibleLists.length === 0 && lists.length === 0 && (
          <div className="contacts-list-empty">Create a list or import a CSV to get started.</div>
        )}
      </div>
    </>
  );
}

function ContactListRow({
  name, description, count, exporting, deleting, onView, onExport, onDelete,
}) {
  return (
    <div className="contact-list-row">
      <div className="contact-list-info">
        <strong>{name}</strong>
        {description && <span>{description}</span>}
      </div>
      <span className="badge neutral contact-count">{count} contacts</span>
      <div className="actions contact-list-actions">
        <button type="button" className="secondary small" onClick={onView}>View</button>
        <button type="button" className="secondary small" onClick={onExport} disabled={exporting}>
          {exporting ? 'Exporting...' : 'Export'}
        </button>
        {onDelete && (
          <button type="button" className="secondary small" onClick={onDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}

function ContactsDrawer({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" role="presentation" onClick={onClose} />
      <section className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="contacts-drawer-title">
        <div className="drawer-header">
          <h3 id="contacts-drawer-title" style={{ margin: 0 }}>{title}</h3>
          <button type="button" className="secondary small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="drawer-body contacts-drawer-body">{children}</div>
      </section>
    </>
  );
}
