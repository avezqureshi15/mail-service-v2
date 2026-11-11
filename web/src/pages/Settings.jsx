import { useEffect, useState } from 'react';
import { api, formatDate } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import MailboxesTab from '../components/MailboxesTab.jsx';

export default function Settings({ user }) {
  const [tab, setTab] = useState('sending');
  const isAdmin = user.role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>
            {isAdmin
              ? 'Sending mailboxes, plus the pacing and safety limits that apply to every campaign.'
              : 'Read-only. Ask an administrator to change these.'}
          </p>
        </div>
      </div>

      <div className="preview-tabs">
        <button type="button" className={tab === 'sending' ? 'active' : ''} onClick={() => setTab('sending')}>
          Sending
        </button>
        <button type="button" className={tab === 'mailboxes' ? 'active' : ''} onClick={() => setTab('mailboxes')}>
          Mailboxes
        </button>
        {isAdmin && (
          <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            Users
          </button>
        )}
        {isAdmin && (
          <button type="button" className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
            Activity
          </button>
        )}
      </div>

      {tab === 'sending' && <SendingSettings isAdmin={isAdmin} />}
      {tab === 'mailboxes' && <MailboxesTab isAdmin={isAdmin} />}
      {tab === 'users' && isAdmin && <Users currentUser={user} />}
      {tab === 'audit' && isAdmin && <Audit />}
    </>
  );
}

function SendingSettings({ isAdmin }) {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/settings').then((d) => setSettings(d.settings)).catch((e) => setError(e.message));
  }, []);

  if (!settings) return <p className="muted">Loading...</p>;

  const set = (patch) => setSettings({ ...settings, ...patch });

  async function save() {
    setError('');
    setBusy(true);
    try {
      const { settings: updated } = await api.patch('/settings', {
        dailyCap: Number(settings.dailyCap),
        hourlyCap: Number(settings.hourlyCap),
        minIntervalSeconds: Number(settings.minIntervalSeconds),
        jitterPercent: Number(settings.jitterPercent),
        perDomainHourlyCap: Number(settings.perDomainHourlyCap),
        sendWindowStartHour: Number(settings.sendWindowStartHour),
        sendWindowEndHour: Number(settings.sendWindowEndHour),
        sendOnWeekends: Boolean(settings.sendOnWeekends),
        warmupEnabled: Boolean(settings.warmupEnabled),
        warmupStartedOn: settings.warmupStartedOn || null,
        maxBounceRatePercent: Number(settings.maxBounceRatePercent),
        maxComplaintRatePercent: Number(settings.maxComplaintRatePercent),
        softBounceLimit: Number(settings.softBounceLimit),
        maxSendAttempts: Number(settings.maxSendAttempts),
        requireDomainAuth: Boolean(settings.requireDomainAuth),
        excludeRoleAccounts: Boolean(settings.excludeRoleAccounts),
        sequenceWaitUnit: settings.sequenceWaitUnit,
      });
      setSettings(updated);
      toast.success('Settings saved.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h3>Volume and pacing</h3>
        <div className="row">
          <Num label="Daily cap" value={settings.dailyCap} disabled={!isAdmin}
            onChange={(v) => set({ dailyCap: v })}
            hint="Keep well below your provider's limit. Zoho's is dynamic and not published." />
          <Num label="Hourly cap" value={settings.hourlyCap} disabled={!isAdmin}
            onChange={(v) => set({ hourlyCap: v })} />
        </div>
        <div className="row">
          <Num label="Seconds between sends" value={settings.minIntervalSeconds} disabled={!isAdmin}
            onChange={(v) => set({ minIntervalSeconds: v })} />
          <Num label="Jitter %" value={settings.jitterPercent} disabled={!isAdmin}
            onChange={(v) => set({ jitterPercent: v })}
            hint="Randomises the gap so the pattern is not metronomic." />
        </div>
        <Num label="Per-domain hourly cap" value={settings.perDomainHourlyCap} disabled={!isAdmin}
          onChange={(v) => set({ perDomainHourlyCap: v })}
          hint="Caps messages to any one receiving domain per hour. Hitting 200 gmail.com addresses in a minute is a bulk signature." />
      </div>

      <div className="card">
        <h3>Sending window</h3>
        <div className="row">
          <Num label="Start hour" value={settings.sendWindowStartHour} disabled={!isAdmin}
            onChange={(v) => set({ sendWindowStartHour: v })} />
          <Num label="End hour" value={settings.sendWindowEndHour} disabled={!isAdmin}
            onChange={(v) => set({ sendWindowEndHour: v })} />
        </div>
        <Check label="Send at weekends" checked={settings.sendOnWeekends} disabled={!isAdmin}
          onChange={(v) => set({ sendOnWeekends: v })}
          hint="Cold outreach arriving on a Sunday reads as automated." />
      </div>

      <div className="card">
        <h3>Warm-up</h3>
        <Check label="Ramp volume gradually" checked={settings.warmupEnabled} disabled={!isAdmin}
          onChange={(v) => set({ warmupEnabled: v })}
          hint="A new domain that suddenly sends hundreds of messages looks compromised. The ramp starts around 20/day and builds over several weeks." />
        <div className="field">
          <label htmlFor="warmupDate">Warm-up start date</label>
          <input
            id="warmupDate"
            type="date"
            value={settings.warmupStartedOn ?? ''}
            disabled={!isAdmin}
            onChange={(e) => set({ warmupStartedOn: e.target.value })}
          />
          <div className="hint">Leave empty to skip warm-up and use the daily cap directly.</div>
        </div>
      </div>

      <div className="card">
        <h3>Safety limits</h3>
        <div className="row">
          <Num label="Max bounce rate %" value={settings.maxBounceRatePercent} disabled={!isAdmin}
            step="0.1" onChange={(v) => set({ maxBounceRatePercent: v })} />
          <Num label="Max complaint rate %" value={settings.maxComplaintRatePercent} disabled={!isAdmin}
            step="0.01" onChange={(v) => set({ maxComplaintRatePercent: v })}
            hint="Gmail and Yahoo expect under 0.3%." />
        </div>
        <p className="hint">
          Sending auto-pauses if either rate is exceeded over the last 24 hours.
        </p>
        <div className="row">
          <Num label="Soft bounces before suppressing" value={settings.softBounceLimit} disabled={!isAdmin}
            onChange={(v) => set({ softBounceLimit: v })} />
          <Num label="Send attempts before giving up" value={settings.maxSendAttempts} disabled={!isAdmin}
            onChange={(v) => set({ maxSendAttempts: v })} />
        </div>
        <Check label="Block sending while SPF or DKIM is failing" checked={settings.requireDomainAuth}
          disabled={!isAdmin} onChange={(v) => set({ requireDomainAuth: v })}
          hint="Strongly recommended. Unauthenticated bulk mail goes to spam regardless of how carefully it is paced." />
        <Check label="Exclude role accounts on import" checked={settings.excludeRoleAccounts}
          disabled={!isAdmin} onChange={(v) => set({ excludeRoleAccounts: v })}
          hint="info@, sales@, support@ and similar generate disproportionate complaints." />
      </div>

      <div className="card">
        <h3>Testing</h3>
        <div className="field">
          <label htmlFor="waitUnit">Follow-up waits are counted in</label>
          <select
            id="waitUnit"
            value={settings.sequenceWaitUnit}
            disabled={!isAdmin}
            onChange={(e) => set({ sequenceWaitUnit: e.target.value })}
          >
            <option value="days">Days (normal)</option>
            <option value="minutes">Minutes (testing only)</option>
          </select>
          <div className="hint">
            Set to minutes to exercise a sequence end to end without waiting
            days - a 3-day step then fires 3 minutes later.
          </div>
        </div>

        {settings.sequenceWaitUnit === 'minutes' && (
          <div className="alert error">
            <strong>Testing mode is active.</strong> With real prospects this
            would send an entire sequence within the hour. Set it back to days
            before any live campaign.
          </div>
        )}
      </div>

      {isAdmin && (
        <button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving...' : 'Save settings'}
        </button>
      )}
    </>
  );
}

function Users({ currentUser }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'sender' });
  const [error, setError] = useState('');

  async function load() {
    try {
      setUsers((await api.get('/users')).users);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function create(event) {
    event.preventDefault();
    setError('');
    try {
      await api.post('/users', form);
      toast.success(`${form.email} can now sign in.`);
      setForm({ email: '', name: '', password: '', role: 'sender' });
      load();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    }
  }

  async function toggle(target) {
    setError('');
    try {
      await api.patch(`/users/${target.id}/active`, { isActive: !target.is_active });
      toast.success(`${target.email} ${target.is_active ? 'deactivated' : 'reactivated'}.`);
      load();
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    }
  }

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h3>Add a team member</h3>
        <form onSubmit={create}>
          <div className="row">
            <div className="field">
              <label htmlFor="uemail">Email</label>
              <input id="uemail" type="email" required value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="uname">Name</label>
              <input id="uname" type="text" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="upass">Password</label>
              <input id="upass" type="password" required minLength={12} value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <div className="hint">At least 12 characters.</div>
            </div>
            <div className="field">
              <label htmlFor="urole">Role</label>
              <select id="urole" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="sender">Sender - run campaigns</option>
                <option value="admin">Administrator - also manage users and settings</option>
              </select>
            </div>
          </div>
          <button type="submit">Create user</button>
        </form>
      </div>

      <div className="card">
        <h3>Team</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.email}</td>
                  <td>{u.name || '--'}</td>
                  <td><span className="badge neutral">{u.role}</span></td>
                  <td>
                    <span className={`badge ${u.is_active ? 'good' : 'bad'}`}>
                      {u.is_active ? 'active' : 'disabled'}
                    </span>
                  </td>
                  <td className="muted nowrap">{u.last_login_at ? formatDate(u.last_login_at) : 'never'}</td>
                  <td>
                    {u.id !== currentUser.id && (
                      <button type="button" className="secondary small" onClick={() => toggle(u)}>
                        {u.is_active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Deactivating someone ends their session on their next request.
        </p>
      </div>
    </>
  );
}

function Audit() {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    api.get('/settings/audit').then((d) => setEntries(d.entries)).catch(() => setEntries([]));
  }, []);

  return (
    <div className="card">
      <h3>Recent activity</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="muted nowrap">{formatDate(e.created_at)}</td>
                <td>{e.user_name || e.user_email || '--'}</td>
                <td className="mono">{e.action}</td>
                <td className="muted">{describeDetail(e.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Num({ label, value, onChange, hint, disabled, step }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} step={step ?? '1'} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function Check({ label, checked, onChange, hint, disabled }) {
  return (
    <div className="checkbox field">
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <label>
        {label}
        {hint && <div className="hint">{hint}</div>}
      </label>
    </div>
  );
}

/**
 * The audit detail arrives as an object now that the column is JSONB, and
 * React cannot render one directly - it throws and takes the whole page
 * with it. An empty detail shows as nothing rather than "{}".
 */
function describeDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail === '{}' ? '' : detail;
  const text = JSON.stringify(detail);
  return text === '{}' ? '' : text;
}
