import { useEffect, useState } from 'react';
import { api, formatDate } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

/**
 * The sending mailboxes.
 *
 * Credentials used to live in .env, which meant one account for the whole
 * service and a redeploy to change it. They live in the database now, so this
 * is where a Zoho or Google mailbox is added, verified and paced - and what
 * the campaign wizard's sender picker reads from.
 *
 * A password is write-only everywhere here: the server never sends one back,
 * so an empty field on an existing mailbox means "leave it alone".
 */

const BLANK = {
  label: '',
  provider: 'zoho',
  region: '',
  fromName: '',
  fromEmail: '',
  replyTo: '',
  sendingDomain: '',
  dkimSelector: '',
  smtpHost: '',
  smtpPort: '',
  smtpUser: '',
  smtpPassword: '',
  imapEnabled: true,
  imapHost: '',
  imapPort: '',
  imapUser: '',
  imapPassword: '',
  dailyCap: '',
  hourlyCap: '',
  warmupEnabled: true,
  warmupStartedOn: '',
  isActive: true,
  isDefault: false,
};

export default function MailboxesTab({ isAdmin }) {
  const toast = useToast();
  const [mailboxes, setMailboxes] = useState(null);
  const [domainLoad, setDomainLoad] = useState([]);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [diagnosis, setDiagnosis] = useState(null);

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    api.get('/mailboxes/providers')
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => { /* the form still works, just without auto-fill */ });
  }, []);

  async function refresh() {
    try {
      const data = await api.get('/mailboxes');
      setMailboxes(data.mailboxes ?? []);
      setDomainLoad(data.domainLoad ?? []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function verify(mailbox) {
    setBusyId(mailbox.id);
    try {
      const { result } = await api.post(`/mailboxes/${mailbox.id}/verify`);
      const parts = [
        result.smtp.ok ? 'SMTP OK' : `SMTP failed: ${result.smtp.error}`,
        result.imap.skipped ? null : (result.imap.ok ? 'IMAP OK' : `IMAP failed: ${result.imap.error}`),
        result.dns?.passing === undefined ? null : (result.dns.passing ? 'DNS OK' : 'DNS failing'),
      ].filter(Boolean);

      const everythingPassed = result.smtp.ok
        && (result.imap.skipped || result.imap.ok)
        && result.dns?.passing !== false;
      toast[everythingPassed ? 'success' : 'error'](parts.join(' - '));

      // A bare OpenSSL code tells you nothing about what to do next, and the
      // tempting fix - stop verifying certificates - would be the wrong one.
      const hint = result.smtp.hint ?? result.imap.hint;
      if (hint) setDiagnosis({ id: mailbox.id, hint });
      else setDiagnosis(null);

      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function testSend(mailbox) {
    setBusyId(mailbox.id);
    try {
      const { sentTo } = await api.post(`/mailboxes/${mailbox.id}/test-send`);
      toast.success(`Test sent to ${sentTo} from ${mailbox.from_email}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(mailbox) {
    setBusyId(mailbox.id);
    try {
      await api.del(`/mailboxes/${mailbox.id}`);
      toast.success(`Removed ${mailbox.label}`);
      await refresh();
    } catch (err) {
      // The server refuses to delete a mailbox with campaign history and says
      // what to do instead, so surface its detail rather than just the error.
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!mailboxes) return <p className="muted">Loading...</p>;

  const overloaded = domainLoad.filter((d) => d.dailyCap > 2000);

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      {mailboxes.length === 0 && (
        <div className="card">
          <h3>No sending mailboxes yet</h3>
          <p className="muted">
            A campaign needs a mailbox to send from. Add the Zoho or Google account you
            send outreach with - you will need an app-specific password, not the account
            password.
          </p>
        </div>
      )}

      {overloaded.length > 0 && (
        <div className="banner warning">
          {overloaded.map((d) => (
            <div key={d.domain}>
              Mailboxes on <strong>{d.domain}</strong> allow {d.dailyCap}/day between them.
              Receivers judge the domain, not the mailbox, so the combined figure is what
              counts against its reputation.
            </div>
          ))}
        </div>
      )}

      {mailboxes.map((mailbox) => (
        <div className="card" key={mailbox.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h3 style={{ marginBottom: 4 }}>
                {mailbox.label}
                {mailbox.is_default && <span className="badge good" style={{ marginLeft: 8 }}>default</span>}
                {!mailbox.is_active && <span className="badge neutral" style={{ marginLeft: 8 }}>inactive</span>}
              </h3>
              <div className="muted" style={{ fontSize: 13 }}>
                {mailbox.from_name ? `${mailbox.from_name} <${mailbox.from_email}>` : mailbox.from_email}
                {' - '}
                {mailbox.providerLabel} via {mailbox.smtp_host}:{mailbox.smtp_port}
              </div>
            </div>
            {isAdmin && (
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="secondary small" disabled={busyId === mailbox.id}
                  onClick={() => verify(mailbox)}>
                  {busyId === mailbox.id ? 'Working...' : 'Test connection'}
                </button>
                <button type="button" className="secondary small" disabled={busyId === mailbox.id}
                  onClick={() => testSend(mailbox)}>
                  Send test
                </button>
                <button type="button" className="secondary small"
                  onClick={() => setEditing(toForm(mailbox))}>
                  Edit
                </button>
                <button type="button" className="secondary small" disabled={busyId === mailbox.id}
                  onClick={() => remove(mailbox)}>
                  Delete
                </button>
              </div>
            )}
          </div>

          <div className="review-summary" style={{ marginTop: 14 }}>
            <div className="item">
              <div className="label">Daily cap</div>
              <div className="value">{mailbox.pacing.dailyCap}</div>
            </div>
            <div className="item">
              <div className="label">Today&rsquo;s allowance</div>
              <div className="value">{mailbox.warmup.allowance}</div>
            </div>
            <div className="item">
              <div className="label">Warm-up</div>
              <div className="value">
                {mailbox.warmup.active ? `day ${mailbox.warmup.day} of ${mailbox.warmup.totalDays}` : 'complete'}
              </div>
            </div>
            <div className="item">
              <div className="label">Verified</div>
              <div className="value">{mailbox.last_verified_at ? formatDate(mailbox.last_verified_at) : 'never'}</div>
            </div>
          </div>

          {mailbox.last_verify_error && (
            <div className="alert error" style={{ marginTop: 12 }}>
              Last check failed: {mailbox.last_verify_error}
            </div>
          )}
          {diagnosis?.id === mailbox.id && (
            <div className="banner warning" style={{ marginTop: 12 }}>{diagnosis.hint}</div>
          )}
          {mailbox.paused_until && (
            <div className="banner warning" style={{ marginTop: 12 }}>
              Paused until {formatDate(mailbox.paused_until)} &mdash; {mailbox.pause_reason}
            </div>
          )}
          {!mailbox.imap_enabled && (
            <div className="hint" style={{ marginTop: 12 }}>
              IMAP is off, so bounces and replies from this mailbox are not detected. Sends
              still work, but a dead address keeps being mailed and a sequence will not stop
              when someone answers.
            </div>
          )}
          {mailbox.bulkPolicyNote && (
            <div className="hint" style={{ marginTop: 8 }}>{mailbox.bulkPolicyNote}</div>
          )}
        </div>
      ))}

      {isAdmin && !editing && (
        <button type="button" onClick={() => setEditing({ ...BLANK })}>Add a mailbox</button>
      )}

      {editing && (
        <MailboxForm
          value={editing}
          providers={providers}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      )}
    </>
  );
}

/** Database row to form state. Passwords are never sent back, so stay blank. */
function toForm(mailbox) {
  return {
    id: mailbox.id,
    label: mailbox.label,
    provider: mailbox.provider,
    region: mailbox.region ?? '',
    fromName: mailbox.from_name ?? '',
    fromEmail: mailbox.from_email,
    replyTo: mailbox.reply_to ?? '',
    sendingDomain: mailbox.sending_domain ?? '',
    dkimSelector: mailbox.dkim_selector ?? '',
    smtpHost: mailbox.smtp_host ?? '',
    smtpPort: String(mailbox.smtp_port ?? ''),
    smtpUser: mailbox.smtp_user ?? '',
    smtpPassword: '',
    imapEnabled: mailbox.imap_enabled,
    imapHost: mailbox.imap_host ?? '',
    imapPort: String(mailbox.imap_port ?? ''),
    imapUser: mailbox.imap_user ?? '',
    imapPassword: '',
    dailyCap: mailbox.daily_cap == null ? '' : String(mailbox.daily_cap),
    hourlyCap: mailbox.hourly_cap == null ? '' : String(mailbox.hourly_cap),
    warmupEnabled: mailbox.warmup_enabled,
    warmupStartedOn: mailbox.warmup_started_on ?? '',
    isActive: mailbox.is_active,
    isDefault: mailbox.is_default,
    hasSmtpPassword: mailbox.hasSmtpPassword,
    hasImapPassword: mailbox.hasImapPassword,
  };
}

function MailboxForm({ value, providers, onCancel, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const preset = providers.find((p) => p.id === form.provider);
  const isNew = !form.id;
  const set = (patch) => setForm({ ...form, ...patch });

  /**
   * Picking a provider fills in everything that follows from it, so adding a
   * mailbox is an address and a password rather than eight hostname fields.
   * Only blank fields are touched, so an edited host is never clobbered.
   */
  function changeProvider(id) {
    const next = providers.find((p) => p.id === id);
    setForm({
      ...form,
      provider: id,
      smtpHost: next?.smtpHost || '',
      smtpPort: next?.smtpPort ? String(next.smtpPort) : '',
      imapHost: next?.imapHost || '',
      imapPort: next?.imapPort ? String(next.imapPort) : '',
      dkimSelector: next?.dkimSelector || '',
    });
  }

  async function save() {
    setError('');
    setBusy(true);
    try {
      const payload = {
        label: form.label,
        provider: form.provider,
        region: form.region || null,
        fromName: form.fromName,
        fromEmail: form.fromEmail,
        replyTo: form.replyTo,
        sendingDomain: form.sendingDomain || undefined,
        dkimSelector: form.dkimSelector || undefined,
        smtpHost: form.smtpHost || undefined,
        smtpPort: form.smtpPort ? Number(form.smtpPort) : undefined,
        smtpUser: form.smtpUser || undefined,
        imapEnabled: form.imapEnabled,
        imapHost: form.imapHost || undefined,
        imapPort: form.imapPort ? Number(form.imapPort) : undefined,
        imapUser: form.imapUser || undefined,
        dailyCap: form.dailyCap === '' ? null : Number(form.dailyCap),
        hourlyCap: form.hourlyCap === '' ? null : Number(form.hourlyCap),
        warmupEnabled: form.warmupEnabled,
        warmupStartedOn: form.warmupStartedOn || null,
        isActive: form.isActive,
        isDefault: form.isDefault,
      };

      // Only send a password when one was actually typed, so saving an edit
      // without retyping it leaves the stored credential untouched.
      if (form.smtpPassword) payload.smtpPassword = form.smtpPassword;
      if (form.imapPassword) payload.imapPassword = form.imapPassword;

      if (isNew) await api.post('/mailboxes', payload);
      else await api.patch(`/mailboxes/${form.id}`, payload);

      toast.success(isNew ? 'Mailbox added' : 'Mailbox saved');
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>{isNew ? 'Add a mailbox' : `Edit ${value.label}`}</h3>
      {error && <div className="alert error">{error}</div>}

      <div className="row">
        <div className="field">
          <label htmlFor="mb-label">Name</label>
          <input id="mb-label" value={form.label} onChange={(e) => set({ label: e.target.value })}
            placeholder="Avez - Zoho" />
          <div className="hint">Shown in the campaign wizard. Only the team sees it.</div>
        </div>
        <div className="field">
          <label htmlFor="mb-provider">Provider</label>
          <select id="mb-provider" value={form.provider} onChange={(e) => changeProvider(e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {preset?.regions && (
        <div className="field">
          <label htmlFor="mb-region">Data centre</label>
          <select id="mb-region" value={form.region} onChange={(e) => set({ region: e.target.value })}>
            <option value="">Global (.com)</option>
            {Object.entries(preset.regions).map(([id, name]) => (
              <option key={id} value={id}>{name} (.{id})</option>
            ))}
          </select>
          <div className="hint">
            Must match the data centre the account lives in - the SPF include differs per
            region, and a mismatch authenticates nothing.
          </div>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="mb-from-name">Sender name</label>
          <input id="mb-from-name" value={form.fromName} onChange={(e) => set({ fromName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mb-from-email">Sender email</label>
          <input id="mb-from-email" type="email" value={form.fromEmail}
            onChange={(e) => set({ fromEmail: e.target.value, ...(isNew ? { smtpUser: e.target.value } : {}) })} />
          {preset?.fromMustMatchUser && (
            <div className="hint">
              {preset.label} sends only as the authenticated mailbox, so this has to equal
              the SMTP username below (or be a verified &ldquo;Send mail as&rdquo; alias).
            </div>
          )}
        </div>
      </div>

      <div className="field">
        <label htmlFor="mb-reply">Reply-to</label>
        <input id="mb-reply" type="email" value={form.replyTo}
          onChange={(e) => set({ replyTo: e.target.value })} placeholder="Defaults to the sender address" />
      </div>

      <h4>SMTP</h4>
      <div className="row">
        <div className="field">
          <label htmlFor="mb-smtp-host">Host</label>
          <input id="mb-smtp-host" value={form.smtpHost} onChange={(e) => set({ smtpHost: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mb-smtp-port">Port</label>
          <input id="mb-smtp-port" type="number" value={form.smtpPort}
            onChange={(e) => set({ smtpPort: e.target.value })} />
          <div className="hint">465 is implicit TLS. 587 negotiates STARTTLS.</div>
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="mb-smtp-user">Username</label>
          <input id="mb-smtp-user" value={form.smtpUser} onChange={(e) => set({ smtpUser: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mb-smtp-pass">App password</label>
          <input id="mb-smtp-pass" type="password" autoComplete="new-password" value={form.smtpPassword}
            onChange={(e) => set({ smtpPassword: e.target.value })}
            placeholder={form.hasSmtpPassword ? 'Stored - leave blank to keep' : ''} />
          <div className="hint">
            An app-specific password, not the account password.
            {preset?.appPasswordUrl && (
              <> <a href={preset.appPasswordUrl} target="_blank" rel="noreferrer">Generate one</a>.</>
            )}
          </div>
        </div>
      </div>

      <h4>IMAP</h4>
      <div className="checkbox">
        <input id="mb-imap" type="checkbox" checked={form.imapEnabled}
          onChange={(e) => set({ imapEnabled: e.target.checked })} />
        <label htmlFor="mb-imap">
          Detect bounces and replies
          <div className="hint">
            Off means this mailbox sends blind: bounced addresses keep being mailed, and a
            sequence will not stop when someone replies.
          </div>
        </label>
      </div>

      {form.imapEnabled && (
        <>
          <div className="row">
            <div className="field">
              <label htmlFor="mb-imap-host">Host</label>
              <input id="mb-imap-host" value={form.imapHost} onChange={(e) => set({ imapHost: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="mb-imap-port">Port</label>
              <input id="mb-imap-port" type="number" value={form.imapPort}
                onChange={(e) => set({ imapPort: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="mb-imap-user">Username</label>
              <input id="mb-imap-user" value={form.imapUser} onChange={(e) => set({ imapUser: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="mb-imap-pass">Password</label>
              <input id="mb-imap-pass" type="password" autoComplete="new-password" value={form.imapPassword}
                onChange={(e) => set({ imapPassword: e.target.value })}
                placeholder={form.hasImapPassword ? 'Stored - leave blank to keep' : ''} />
            </div>
          </div>
        </>
      )}

      <h4>Pacing</h4>
      <div className="row">
        <div className="field">
          <label htmlFor="mb-daily">Daily cap</label>
          <input id="mb-daily" type="number" value={form.dailyCap}
            onChange={(e) => set({ dailyCap: e.target.value })}
            placeholder={preset?.recommendedDailyCap ? `${preset.recommendedDailyCap} (recommended)` : ''} />
          <div className="hint">
            {preset?.dailyLimitNote ?? 'Blank follows the provider preset.'}
          </div>
        </div>
        <div className="field">
          <label htmlFor="mb-hourly">Hourly cap</label>
          <input id="mb-hourly" type="number" value={form.hourlyCap}
            onChange={(e) => set({ hourlyCap: e.target.value })} placeholder="Follows the preset" />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="mb-warm-start">Warm-up started on</label>
          <input id="mb-warm-start" type="date" value={form.warmupStartedOn}
            onChange={(e) => set({ warmupStartedOn: e.target.value })} />
          <div className="hint">Day one of the ramp. Blank means warm-up has not begun.</div>
        </div>
        <div className="field" style={{ alignSelf: 'center' }}>
          <div className="checkbox">
            <input id="mb-warm" type="checkbox" checked={form.warmupEnabled}
              onChange={(e) => set({ warmupEnabled: e.target.checked })} />
            <label htmlFor="mb-warm">Ramp volume gradually</label>
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div className="checkbox">
          <input id="mb-active" type="checkbox" checked={form.isActive}
            onChange={(e) => set({ isActive: e.target.checked })} />
          <label htmlFor="mb-active">Available for sending</label>
        </div>
        <div className="checkbox">
          <input id="mb-default" type="checkbox" checked={form.isDefault}
            onChange={(e) => set({ isDefault: e.target.checked })} />
          <label htmlFor="mb-default">Pre-select for new campaigns</label>
        </div>
      </div>

      <div className="row" style={{ marginTop: 18, gap: 10 }}>
        <button type="button" onClick={save} disabled={busy || !form.label || !form.fromEmail}>
          {busy ? 'Saving...' : (isNew ? 'Add mailbox' : 'Save changes')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
