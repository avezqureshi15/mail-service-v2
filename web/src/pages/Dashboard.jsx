import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';

/**
 * Deliverability health is the first thing on the page, because it is the
 * thing that decides whether anything else works.
 */
export default function Dashboard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  async function load() {
    try {
      setData(await api.get('/dashboard'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  async function recheckDomain() {
    setChecking(true);
    setError('');
    try {
      await api.post('/domain-check');
      await load();
      toast.success('Domain check complete.');
    } catch (err) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setChecking(false);
    }
  }

  if (error && !data) return <div className="alert error">{error}</div>;
  if (!data) return <p className="muted">Loading...</p>;

  const { domainAuth, sender, senders = [], warmup, delivery, contacts, suppressions, campaigns, config } = data;
  const detail = domainAuth?.detail;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Dashboard</h2>
          <p>
            Sending as <strong>{config.fromAddress}</strong> on <strong>{config.sendingDomain}</strong>.
          </p>
        </div>
        <button type="button" className="secondary" onClick={recheckDomain} disabled={checking}>
          {checking ? 'Checking DNS...' : 'Re-check domain'}
        </button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {sender.domainAuth.enforced && sender.domainAuth.passing === false && (
        <div className="alert error">
          <strong>Sending is blocked.</strong> SPF or DKIM is failing, so campaigns will not
          start. {sender.domainAuth.detail}
        </div>
      )}

      {data.sequenceWaitUnit === 'minutes' && (
        <div className="alert error">
          <strong>Sequence testing mode is on.</strong> Follow-up waits are being
          counted in <strong>minutes, not days</strong> - a 3-day step sends 3
          minutes later. Fine for testing, but with real prospects it would
          send an entire sequence within the hour. Turn it off in Settings
          before sending to anyone real.
        </div>
      )}

      {config.mailboxCount === 0 && (
        <div className="alert warn">
          <strong>No sending mailboxes.</strong> Campaigns cannot be started until one is
          configured. Add it under Settings &rsaquo; Mailboxes.
        </div>
      )}

      {config.mailboxCount > 0 && !config.imapEnabled && (
        <div className="alert warn">
          <strong>IMAP is off everywhere.</strong> Bounce handling and reply detection are
          disabled, so dead addresses will not be suppressed automatically and sequences will
          not stop when someone replies. Turn it on for a mailbox under Settings &rsaquo;
          Mailboxes.
        </div>
      )}

      {senders.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Sending mailboxes</h3>
          <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
            Each mailbox paces itself, so one hitting its ceiling does not stop the others.
          </p>
          <table>
            <thead>
              <tr>
                <th>Mailbox</th>
                <th>Today</th>
                <th>Last hour</th>
                <th>Warm-up</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {senders.map((s) => (
                <tr key={s.mailboxId}>
                  <td>
                    <div>{s.mailboxLabel}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{s.fromEmail}</div>
                  </td>
                  <td>{s.sentToday} / {s.dailyAllowance}</td>
                  <td>{s.sentLastHour} / {s.hourlyCap}</td>
                  <td>
                    {s.warmup.active ? `day ${s.warmup.day} of ${s.warmup.totalDays}` : 'complete'}
                  </td>
                  <td>
                    {s.pausedUntil
                      ? <span className="badge bad" title={s.pauseReason ?? ''}>paused</span>
                      : s.domainAuth.passing === false
                        ? <span className="badge bad" title={s.domainAuth.detail ?? ''}>DNS failing</span>
                        : s.running
                          ? <span className="badge good">sending</span>
                          : <span className="badge neutral" title={s.reason ?? ''}>idle</span>}
                    {s.reason && !s.pausedUntil && (
                      <div className="muted" style={{ fontSize: 12 }}>{s.reason}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat
          label="Sent today"
          value={sender.sentToday}
          sub={`of ${sender.dailyAllowance} allowed`}
        />
        <Stat
          label="Bounce rate"
          value={`${delivery.bounceRate}%`}
          sub={`${delivery.hardBounces} hard, ${delivery.softBounces} soft (24h)`}
          tone={delivery.bounceRate > 5 ? 'bad' : delivery.bounceRate > 2 ? 'warn' : 'good'}
        />
        <Stat
          label="Complaint rate"
          value={`${delivery.complaintRate}%`}
          sub="keep below 0.3%"
          tone={delivery.complaintRate > 0.3 ? 'bad' : 'good'}
        />
        <Stat
          label="Suppressed"
          value={suppressions}
          sub={`${contacts.active} active contacts`}
        />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Sending status</h3>
          <Row label="Worker">
            <span className={`badge ${sender.running ? 'good' : 'bad'}`}>
              {sender.running ? 'Running' : 'Stopped'}
            </span>
          </Row>
          <Row label="Send window">
            {sender.withinSendWindow
              ? <span className="badge good">Open</span>
              : <span className="badge neutral" title={sender.windowReason ?? ''}>Closed</span>}
          </Row>
          <Row label="Remaining today">{sender.remainingToday}</Row>
          <Row label="Last hour">{sender.sentLastHour} / {sender.hourlyCap}</Row>
          {warmup.active && (
            <Row label="Warm-up">
              Day {warmup.day} of {warmup.totalDays} &middot; {warmup.allowance}/day
            </Row>
          )}
          {sender.throttledDomains.length > 0 && (
            <Row label="Paced domains">
              <span className="muted">{sender.throttledDomains.join(', ')}</span>
            </Row>
          )}
        </div>

        <div className="card">
          <h3>Recent campaigns</h3>
          {campaigns.length === 0 ? (
            <div className="empty">
              No campaigns yet. <Link to="/campaigns/new">Create one</Link>.
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Name</th><th>Status</th><th className="num">Sent</th></tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="num">{c.sent_count} / {c.total_jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Last, because it is near-static: once SPF and DKIM are green they
          stay green for months, while the numbers above change constantly.
          A failure still surfaces at the top of the page as an alert. */}
      <DomainAuthCard domainAuth={domainAuth} detail={detail} onCheck={recheckDomain} checking={checking} />
    </>
  );
}

function DomainAuthCard({ domainAuth, detail, onCheck, checking }) {
  if (!domainAuth) {
    return (
      <div className="card">
        <h3>Domain authentication</h3>
        <div className="empty">
          <p>Not checked yet. This is the single biggest factor in whether your mail reaches the inbox.</p>
          <button type="button" onClick={onCheck} disabled={checking}>
            {checking ? 'Checking...' : 'Run the check'}
          </button>
        </div>
      </div>
    );
  }

  const checks = [
    { key: 'spf', label: 'SPF', ok: domainAuth.spfOk, info: detail?.spf },
    { key: 'dkim', label: 'DKIM', ok: domainAuth.dkimOk, info: detail?.dkim },
    { key: 'dmarc', label: 'DMARC', ok: domainAuth.dmarcOk, info: detail?.dmarc },
  ];

  return (
    <div className="card">
      <h3>Domain authentication</h3>
      {checks.map((check) => (
        <div className="check-row" key={check.key}>
          <span className={`dot ${check.ok ? 'good' : 'bad'}`} />
          <div className="body">
            <div className="name">
              {check.label} <span className={`badge ${check.ok ? 'good' : 'bad'}`}>
                {check.ok ? 'Pass' : 'Fail'}
              </span>
            </div>
            {check.info?.summary && <div className="detail">{check.info.summary}</div>}
            {!check.ok && check.info?.detail && <div className="detail">{check.info.detail}</div>}
          </div>
        </div>
      ))}
      <p className="hint" style={{ marginTop: 10 }}>
        Last checked {formatDate(domainAuth.checkedAt)}
      </p>
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="check-row">
      <div className="body" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span className="muted">{label}</span>
        <span>{children}</span>
      </div>
    </div>
  );
}

export function StatusBadge({ status }) {
  const tone = {
    draft: 'neutral',
    scheduled: 'warn',
    sending: 'good',
    paused: 'warn',
    completed: 'neutral',
    cancelled: 'bad',
  }[status] ?? 'neutral';
  return <span className={`badge ${tone}`}>{status}</span>;
}
