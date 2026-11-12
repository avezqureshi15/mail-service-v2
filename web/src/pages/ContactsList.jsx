import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import ImportPanel from '../components/ImportPanel.jsx';

export default function ContactsList() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isAll = id === 'all';
  const listId = isAll ? null : Number(id);

  const [list, setList] = useState(null);
  const [lists, setLists] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [counts, setCounts] = useState({});
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ search, limit: '100' });
      if (!isAll) params.set('listId', String(listId));
      const calls = [api.get(`/contacts?${params}`), api.get('/lists')];
      if (!isAll) calls.push(api.get(`/lists/${listId}`));
      const [contactData, listsData, listDetail] = await Promise.all(calls);
      setContacts(contactData.contacts);
      setCounts(contactData.counts);
      setLists(listsData.lists);
      if (listDetail) setList(listDetail.list);
    } catch (err) {
      if (err.status === 404) {
        navigate('/contacts', { replace: true });
        return;
      }
      setError(err.message);
    }
  }, [search, listId, isAll, navigate]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function deleteList() {
    if (!list) return;
    if (!window.confirm(`Delete list "${list.name}"? Contacts stay - they are just removed from this list.`)) return;
    setBusy(true);
    try {
      await api.del(`/lists/${listId}`);
      toast.success(`Deleted list "${list.name}"`);
      navigate('/contacts');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const title = isAll ? 'All contacts' : (list?.name ?? '...');

  return (
    <>
      <div className="header-breadcrumb" style={{ marginBottom: 10 }}>
        <Link className="breadcrumb-link" to="/contacts">Contacts</Link>
        <span className="breadcrumb-sep">/</span>
        <span className="breadcrumb-current">{title}</span>
      </div>

      <div className="page-head">
        <div>
          <h2>{title}</h2>
          <p>
            {counts.active ?? 0} active, {counts.unsubscribed ?? 0} unsubscribed,
            {' '}{counts.bounced ?? 0} bounced.
          </p>
        </div>
        <div className="actions">
          {!isAll && list && (
            <button type="button" className="danger" onClick={deleteList} disabled={busy}>
              Delete list
            </button>
          )}
          <button type="button" onClick={() => setImporting(true)}>Import CSV</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {importing && (
        <ImportPanel
          lists={lists}
          currentListId={isAll ? '' : String(listId)}
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
