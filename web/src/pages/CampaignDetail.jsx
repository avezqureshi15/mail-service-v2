import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDate, pct } from '../lib/api.js';
import { StatusBadge } from './Dashboard.jsx';

export default function CampaignDetail({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState(null);
  const [recipients, setRecipients] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewMode, setPreviewMode] = useState('desktop');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [blockers, setBlockers] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, recipientData] = await Promise.all([
        api.get(`/campaigns/${id}`),
        api.get(`/campaigns/${id}/recipients?limit=200`),
      ]);
      setCampaign(detail.campaign);
      setRecipients(recipientData.recipients);
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(path, label) {
    setError('');
    setNotice('');
    setBlockers([]);
    setBusy(true);
    try {
      const result = await api.post(`/campaigns/${id}/${path}`);
      setNotice(result.queued !== undefined
        ? `${label} - ${result.queued} message(s) queued for ${result.recipients} recipient(s).`
        : `${label}.`);
      await load();
    } catch (err) {
      setError(err.message);
      if (err.details) setBlockers(err.details);
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await api.post(`/campaigns/${id}/test`, {});
      setNotice(`Test message sent to ${result.sentTo}. Check it landed in the inbox, not spam.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    setError('');
    try {
      setPreview(await api.post(`/campaigns/${id}/preview`, {}));
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !campaign) return <div className="alert error">{error}</div>;
  if (!campaign) return <p className="muted">Loading...</p>;

  const { stats, engagement, enrollments } = campaign;
  const progress = stats.total > 0 ? Math.round((stats.sent / stats.total) * 100) : 0;
  const canEdit = campaign.status === 'draft';
  const canStart = ['draft', 'paused', 'scheduled'].includes(campaign.status);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{campaign.name} <StatusBadge status={campaign.status} /></h2>
          <p>
            {campaign.is_sequence ? `${campaign.stepCount}-step sequence` : 'Single send'}
            {campaign.tracking_enabled ? ' - tracking on' : ' - tracking off'}
            {campaign.category_name ? ` - category: ${campaign.category_name}` : ''}
            {campaign.sub_category_name ? ` - sub-category: ${campaign.sub_category_name}` : ''}
            {campaign.list_name ? ` - list: ${campaign.list_name}` : ''}
          </p>
        </div>
        <div className="actions">
          {campaign.retryable > 0 && (
            <button type="button" onClick={() => act('retry', `Retrying ${campaign.retryable} message(s)`)} disabled={busy}>
              Retry {campaign.retryable} failed
            </button>
          )}
          <button type="button" className="secondary" onClick={sendTest} disabled={busy}>
            Send test to me
          </button>
          {canEdit && (
            <Link className="btn" to={`/campaigns/${id}/edit`}>Edit</Link>
          )}
          {canStart && (
            <button type="button" onClick={() => act('start', 'Campaign started')} disabled={busy}>
              {campaign.status === 'paused' ? 'Resume' : 'Start sending'}
            </button>
          )}
          {campaign.status === 'sending' && (
            <button
              type="button"
              className="secondary"
              onClick={() => act('pause', 'Campaign paused')}
              disabled={busy}
            >
              Pause
            </button>
          )}
          {['sending', 'paused'].includes(campaign.status) && (
            <button
              type="button"
              className="danger"
              onClick={() => act('cancel', 'Campaign cancelled')}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert success">{notice}</div>}
      {error && <div className="alert error">{error}</div>}
      {blockers.length > 0 && (
        <div className="alert error">
          <strong>Fix these before sending:</strong>
          <ul>{blockers.map((b, i) => <li key={i}>{b.message ?? b.field}</li>)}</ul>
        </div>
      )}
      {campaign.pause_reason && campaign.status === 'paused' && (
        <div className="alert warn"><strong>Paused:</strong> {campaign.pause_reason}</div>
      )}

      <WhyNotSending campaign={campaign} stats={stats} />

      <div className="card">
        <h3>Progress</h3>
        <div className="bar" style={{ marginBottom: 10 }}>
          <span className="good" style={{ width: `${progress}%` }} />
        </div>
        <div className="grid cols-4">
          <Mini label="Sent" value={stats.sent} />
          <Mini label="Queued" value={stats.queued} />
          <Mini label="Failed" value={stats.failed} tone={stats.failed ? 'bad' : undefined} />
          <Mini label="Skipped" value={stats.skipped} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Engagement</h3>
          {campaign.tracking_enabled ? (
            <div className="grid cols-3">
              <Mini label="Opened" value={engagement.opens} sub={pct(engagement.opens, stats.sent)} />
              <Mini label="Clicked" value={engagement.clicks} sub={pct(engagement.clicks, stats.sent)} />
              <Mini label="Replied" value={engagement.replies} sub={pct(engagement.replies, stats.sent)} />
            </div>
          ) : (
            <div className="grid cols-3">
              <Mini label="Replied" value={engagement.replies} sub={pct(engagement.replies, stats.sent)} />
              <Mini label="Unsubscribed" value={engagement.unsubscribes} />
              <Mini label="Bounced" value={engagement.bounces} tone={engagement.bounces ? 'bad' : undefined} />
            </div>
          )}
          {Boolean(campaign.tracking_enabled) && engagement.botHits > 0 && (
            <p className="hint" style={{ marginTop: 12 }}>
              {engagement.botHits} hit(s) from security scanners and image proxies were excluded.
              Clicks and replies are more reliable than opens.
            </p>
          )}
          {!campaign.tracking_enabled && (
            <p className="hint" style={{ marginTop: 12 }}>
              Tracking is off for this campaign, so opens and clicks are not recorded.
              Replies are still detected.
            </p>
          )}
        </div>

        {enrollments && (
          <div className="card">
            <h3>Sequence</h3>
            <div className="grid cols-3">
              <Mini label="In progress" value={enrollments.active} />
              <Mini label="Completed" value={enrollments.completed} />
              <Mini label="Exited early" value={enrollments.exited} />
            </div>
            {Object.keys(enrollments.byReason).length > 0 && (
              <table style={{ marginTop: 14 }}>
                <thead><tr><th>Exit reason</th><th className="num">Count</th></tr></thead>
                <tbody>
                  {Object.entries(enrollments.byReason).map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{reason}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="step-head">
          <h3 style={{ margin: 0 }}>Preview</h3>
          <div className="actions">
            {preview && (
              <div className="preview-tabs" style={{ margin: 0 }}>
                {['desktop', 'mobile', 'text'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={previewMode === mode ? 'active' : ''}
                    onClick={() => setPreviewMode(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="secondary small" onClick={loadPreview}>
              {preview ? 'Refresh' : 'Show preview'}
            </button>
            {preview && (
              <button type="button" className="secondary small" onClick={() => setPreview(null)}>
                Close
              </button>
            )}
          </div>
        </div>

        {preview && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              <strong>Subject:</strong> {preview.subject}
            </p>
            {previewMode === 'text' ? (
              <pre className="preview-text">{preview.text}</pre>
            ) : (
              <iframe
                title="Email preview"
                className={`preview-frame ${previewMode}`}
                /* Sandboxed with no allow-scripts: campaign HTML is
                   untrusted input and must not execute in our origin. */
                sandbox=""
                srcDoc={preview.html}
              />
            )}
          </>
        )}
      </div>

      <div className="card">
        <h3>Recipients</h3>
        {recipients.length === 0 ? (
          <div className="empty">Nothing queued yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  {Boolean(campaign.is_sequence) && <th>Step</th>}
                  <th>Status</th>
                  {Boolean(campaign.tracking_enabled) && <th className="num">Opens</th>}
                  {Boolean(campaign.tracking_enabled) && <th className="num">Clicks</th>}
                  <th className="num">Replies</th>
                  <th>Sent</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.email}</td>
                    {Boolean(campaign.is_sequence) && <td className="num">{r.step_no}</td>}
                    <td><RecipientStatus row={r} /></td>
                    {Boolean(campaign.tracking_enabled) && <td className="num">{r.opens}</td>}
                    {Boolean(campaign.tracking_enabled) && <td className="num">{r.clicks}</td>}
                    <td className="num">{r.replies}</td>
                    <td className="muted nowrap">{r.sent_at ? formatDate(r.sent_at) : '--'}</td>
                    <td className="muted">
                      {r.error ? (
                        <>
                          <div style={{ marginBottom: 5 }}>{r.error}</div>
                          <button
                            type="button"
                            className="secondary small"
                            disabled={busy}
                            onClick={() => act(`retry/${r.id}`, `Retrying ${r.email}`)}
                          >
                            Retry this one
                          </button>
                        </>
                      ) : (r.skip_reason ?? '')}
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
 * Explains a stalled queue.
 *
 * The pacing rules mean a started campaign routinely sends nothing for hours
 * - outside the window, daily cap reached, domain authentication failing.
 * That is correct behaviour, but with "Queued 3" and no explanation it reads
 * as a broken app, so the reason is stated on the page rather than left for
 * someone to deduce.
 */
function WhyNotSending({ campaign, stats }) {
  const sender = campaign.sender;
  if (!sender) return null;
  if (campaign.status !== 'sending') return null;
  if (stats.queued === 0) return null;

  if (!sender.withinSendWindow) {
    return (
      <div className="alert info">
        <strong>Waiting for the sending window.</strong>{' '}
        {stats.queued} message{stats.queued === 1 ? '' : 's'} queued.
        {' '}Sending is restricted to {sender.windowReason?.match(/\(([^)]+)\)/)?.[1] ?? 'business hours'}
        {' '}on weekdays, so these will go out when it next opens. Cold email
        arriving overnight reads as automated.
      </div>
    );
  }

  if (sender.remainingToday <= 0) {
    return (
      <div className="alert info">
        <strong>Today&rsquo;s limit reached.</strong> {sender.sentToday} of{' '}
        {sender.dailyAllowance} sent. The remaining {stats.queued} will continue
        tomorrow.
      </div>
    );
  }

  if (sender.domainAuth?.enforced && sender.domainAuth?.passing === false) {
    return (
      <div className="alert error">
        <strong>Blocked by domain authentication.</strong> {sender.domainAuth.detail}
      </div>
    );
  }

  if (!sender.running) {
    return (
      <div className="alert error">
        <strong>The sending worker is not running.</strong> Nothing will go out
        until the server is restarted.
      </div>
    );
  }

  return null;
}

function RecipientStatus({ row }) {
  if (row.bounce_type === 'hard') return <span className="badge bad">hard bounce</span>;
  if (row.bounce_type === 'complaint') return <span className="badge bad">complaint</span>;
  if (row.bounce_type === 'soft') return <span className="badge warn">soft bounce</span>;

  // Shown whichever message prompted the opt-out. A recipient who has
  // unsubscribed must never read as a plain "sent" here.
  if (row.contact_status === 'unsubscribed') {
    return <span className="badge bad">unsubscribed</span>;
  }

  const tone = { sent: 'good', failed: 'bad', skipped: 'neutral', queued: 'neutral', sending: 'warn' }[row.status];
  return <span className={`badge ${tone ?? 'neutral'}`}>{row.status}</span>;
}

function Mini({ label, value, sub, tone }) {
  return (
    <div>
      <div className="label muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        {label}
      </div>
      <div style={{ fontWeight: 650, fontSize: 20, color: tone ? `var(--${tone})` : undefined }}>
        {value}
      </div>
      {sub && <div className="sub muted" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}
