import { useEffect, useState } from 'react';
import { api, formatDate } from '../lib/api.js';

const REASON_LABELS = {
  unsubscribed: 'Unsubscribed',
  hard_bounce: 'Hard bounce',
  soft_bounce_limit: 'Repeated soft bounces',
  complaint: 'Spam complaint',
  manual: 'Added manually',
  invalid: 'Invalid address',
};

export default function Suppressions() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    try {
      const data = await api.get(`/suppressions?search=${encodeURIComponent(search)}&limit=200`);
      setRows(data.rows);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [search]);

  async function add(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      await api.post('/suppressions', { email });
      setNotice(`${email} will no longer receive any campaign.`);
      setEmail('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(row) {
    setError('');
    setNotice('');
    try {
      await api.del(`/suppressions/${row.id}`);
      setNotice(`${row.email} removed from the suppression list.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Suppression list</h2>
          <p>
            {total} address{total === 1 ? '' : 'es'} that will never be mailed again. This list is
            checked at send time, so it applies even to a campaign already running.
          </p>
        </div>
      </div>

      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h3>Add an address</h3>
        <form onSubmit={add} className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@example.com"
              required
            />
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button type="submit">Suppress</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="field">
          <input
            type="search"
            placeholder="Search suppressed addresses"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {rows.length === 0 ? (
          <div className="empty">Nothing suppressed yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th><th>Reason</th><th>Source</th><th>Added</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.email}</td>
                    <td>
                      <span className={`badge ${row.reason === 'complaint' ? 'bad' : 'neutral'}`}>
                        {REASON_LABELS[row.reason] ?? row.reason}
                      </span>
                    </td>
                    <td className="muted">{row.source || '--'}</td>
                    <td className="muted nowrap">{formatDate(row.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => remove(row)}
                        title="Only do this with explicit consent from the recipient"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="hint" style={{ marginTop: 12 }}>
          Removing someone here re-enables mail to them. Only do it if they have asked to be
          added back - mailing a previously unsubscribed address is what generates spam
          complaints.
        </p>
      </div>
    </>
  );
}
