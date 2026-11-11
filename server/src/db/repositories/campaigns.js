import { query, queryOne, execute, transaction } from '../index.js';
import { getSetting } from './settings.js';

export async function createCampaign({
  name,
  listId = null,
  categoryId = null,
  subCategoryId = null,
  subject = '',
  preheader = '',
  htmlBody = '',
  fromName = '',
  fromEmail = '',
  replyTo = '',
  trackingEnabled = false,
  isSequence = false,
  mailboxId = null,
  createdBy = null,
  tenantId = 1,
}) {
  // A campaign always belongs to a category. Callers that omit one are filed
  // under the tenant's default rather than rejected - the field is
  // organisational, never a sending precondition.
  const resolvedCategoryId = categoryId ?? await getDefaultCategoryId(tenantId);

  const row = await queryOne(
    `INSERT INTO campaigns
       (tenant_id, name, list_id, category_id, sub_category_id, subject, preheader, html_body,
        from_name, from_email, reply_to, tracking_enabled, is_sequence, mailbox_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [tenantId, name, listId, resolvedCategoryId, subCategoryId, subject, preheader, htmlBody,
      fromName, fromEmail, replyTo, Boolean(trackingEnabled), Boolean(isSequence), mailboxId, createdBy],
  );

  return getCampaign(row.id, tenantId);
}

export function getCampaign(id, tenantId = 1) {
  return queryOne(
    `SELECT c.*, cc.name AS category_name, sc.name AS sub_category_name
       FROM campaigns c
       LEFT JOIN campaign_categories cc ON cc.id = c.category_id
       LEFT JOIN sub_categories sc ON sc.id = c.sub_category_id
      WHERE c.id = $1 AND c.tenant_id = $2`,
    [id, tenantId],
  );
}

const UPDATABLE = new Set([
  'name', 'list_id', 'category_id', 'sub_category_id', 'subject', 'preheader', 'html_body', 'from_name',
  'from_email', 'reply_to', 'tracking_enabled', 'is_sequence', 'scheduled_at', 'mailbox_id',
]);

/**
 * Moves a campaign to a different mailbox, taking its still-queued jobs with
 * it.
 *
 * Jobs carry their own mailbox_id, stamped when they were queued - so without
 * this, reassigning a campaign would leave everything already in the queue
 * going out of the old account, which is the trap that stamping buys its
 * other advantages with.
 *
 * Rows already in 'sending' are deliberately left alone: a loop holds them,
 * and the message may be on the wire.
 */
/**
 * Pauses only the campaigns that send from one mailbox.
 *
 * Used when that mailbox's domain authentication is failing. The global
 * breaker in the janitor still pauses everything, because a bounce-rate
 * spike is a domain-wide problem - but one mailbox's missing DKIM selector
 * says nothing about the others.
 */
export function pauseCampaignsForMailbox(mailboxId, reason) {
  return execute(
    `UPDATE campaigns SET status = 'paused', pause_reason = $1, updated_at = now()
      WHERE status = 'sending' AND mailbox_id = $2`,
    [reason, mailboxId],
  );
}

export function reassignMailbox(campaignId, mailboxId, tenantId = 1) {
  return transaction(async (tx) => {
    await tx.execute(
      'UPDATE campaigns SET mailbox_id = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3',
      [mailboxId, campaignId, tenantId],
    );
    const moved = await tx.execute(
      "UPDATE send_jobs SET mailbox_id = $1 WHERE campaign_id = $2 AND status = 'queued'",
      [mailboxId, campaignId],
    );
    return moved;
  });
}

export async function updateCampaign(id, patch, tenantId = 1) {
  const entries = Object.entries(patch).filter(([key]) => UPDATABLE.has(key));
  if (entries.length === 0) return getCampaign(id, tenantId);

  // Column names come from the allowlist above, never from caller input;
  // all values stay parameterized.
  const assignments = entries.map(([key], i) => `${key} = $${i + 1}`).join(', ');
  const values = entries.map(([, value]) => value);

  await execute(
    `UPDATE campaigns SET ${assignments}, updated_at = now()
      WHERE id = $${values.length + 1} AND tenant_id = $${values.length + 2}`,
    [...values, id, tenantId],
  );

  return getCampaign(id, tenantId);
}

export function setCampaignStatus(id, status, { pauseReason = null } = {}) {
  const timestampColumn = status === 'sending' ? ', started_at = COALESCE(started_at, now())'
    : status === 'completed' ? ', completed_at = now()'
      : '';
  return execute(
    `UPDATE campaigns
        SET status = $1, pause_reason = $2, updated_at = now()${timestampColumn}
      WHERE id = $3`,
    [status, pauseReason, id],
  );
}

export async function listCampaigns({
  tenantId = 1, status = null, categoryId = null, subCategoryId = null, limit = 50, offset = 0,
} = {}) {
  const filters = [tenantId, status, categoryId, subCategoryId];

  const where = `
    c.tenant_id = $1
    AND ($2::text IS NULL OR c.status = $2::text)
    AND ($3::int  IS NULL OR c.category_id = $3::int)
    AND ($4::int  IS NULL OR c.sub_category_id = $4::int)
  `;

  const rows = await query(
    `SELECT c.*,
            u.name  AS created_by_name,
            u.email AS created_by_email,
            l.name  AS list_name,
            cc.name AS category_name,
            sc.name AS sub_category_name,
            (SELECT COUNT(*) FROM send_jobs j WHERE j.campaign_id = c.id)                       AS total_jobs,
            (SELECT COUNT(*) FROM send_jobs j WHERE j.campaign_id = c.id AND j.status = 'sent') AS sent_count
       FROM campaigns c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN lists l ON l.id = c.list_id
       LEFT JOIN campaign_categories cc ON cc.id = c.category_id
       LEFT JOIN sub_categories sc ON sc.id = c.sub_category_id
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT $5 OFFSET $6`,
    [...filters, limit, offset],
  );

  const total = (await queryOne(
    `SELECT COUNT(*) AS n FROM campaigns c WHERE ${where}`,
    filters,
  )).n;

  return { rows, total };
}

export async function deleteCampaign(id, tenantId = 1) {
  return (await execute(
    "DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'cancelled')",
    [id, tenantId],
  )) > 0;
}

// --- Categories ------------------------------------------------------------

/** The tenant's default bucket, created on first use. */
export async function getDefaultCategoryId(tenantId = 1) {
  const row = await queryOne(
    `INSERT INTO campaign_categories (tenant_id, name) VALUES ($1, 'Uncategorised')
     ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = campaign_categories.name
     RETURNING id`,
    [tenantId],
  );
  return row.id;
}

/**
 * Categories with how many campaigns use each. Powers both the list filter
 * and the editor dropdown, so an empty category still appears once created.
 */
export function listCategories(tenantId = 1) {
  return query(
    `SELECT cc.id, cc.name, COUNT(c.id) AS count
       FROM campaign_categories cc
       LEFT JOIN campaigns c ON c.category_id = cc.id AND c.tenant_id = cc.tenant_id
      WHERE cc.tenant_id = $1
      GROUP BY cc.id
      ORDER BY lower(cc.name)`,
    [tenantId],
  );
}

/**
 * Creates a category, or returns the existing one on a case-insensitive hit.
 * Returns the row either way so the caller can select it immediately.
 */
export async function createCategory(name, tenantId = 1) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Category name is required');

  // DO UPDATE rather than DO NOTHING so the row comes back either way.
  return queryOne(
    `INSERT INTO campaign_categories (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = campaign_categories.name
     RETURNING *`,
    [tenantId, clean],
  );
}

// --- Sub-categories --------------------------------------------------------

/**
 * Sub-categories belonging to one category, with how many campaigns use each.
 * The editor only ever shows the ones under the category currently selected,
 * and the list filter uses the same rows.
 */
export function listSubCategories(categoryId, tenantId = 1) {
  return query(
    `SELECT sc.id, sc.name, sc.category_id, COUNT(c.id) AS count
       FROM sub_categories sc
       LEFT JOIN campaigns c ON c.sub_category_id = sc.id AND c.tenant_id = sc.tenant_id
      WHERE sc.tenant_id = $1 AND sc.category_id = $2
      GROUP BY sc.id
      ORDER BY lower(sc.name)`,
    [tenantId, categoryId],
  );
}

/**
 * Creates a sub-category under a category, or returns the existing one on a
 * case-insensitive hit within that category. A name may be reused under a
 * different category, since the two are independent groupings.
 */
export async function createSubCategory(name, categoryId, tenantId = 1) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('Sub-category name is required');

  const category = await queryOne(
    'SELECT id FROM campaign_categories WHERE id = $1 AND tenant_id = $2',
    [categoryId, tenantId],
  );
  if (!category) throw new Error('Category not found');

  return queryOne(
    `INSERT INTO sub_categories (tenant_id, category_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, category_id, lower(name)) DO UPDATE SET name = sub_categories.name
     RETURNING *`,
    [tenantId, categoryId, clean],
  );
}

/**
 * True when the sub-category exists and sits under the given category.
 *
 * Without this check a campaign can be filed under one category while
 * carrying a sub-category belonging to another: the foreign key only proves
 * the row exists, not that the pair makes sense.
 */
export async function subCategoryBelongsTo(subCategoryId, categoryId, tenantId = 1) {
  if (subCategoryId === null || subCategoryId === undefined) return true;
  const row = await queryOne(
    'SELECT 1 FROM sub_categories WHERE id = $1 AND category_id = $2 AND tenant_id = $3',
    [subCategoryId, categoryId, tenantId],
  );
  return Boolean(row);
}

// --- Sequence steps --------------------------------------------------------

export function getSteps(campaignId) {
  return query('SELECT * FROM sequence_steps WHERE campaign_id = $1 ORDER BY step_no', [campaignId]);
}

export function getStep(campaignId, stepNo) {
  return queryOne(
    'SELECT * FROM sequence_steps WHERE campaign_id = $1 AND step_no = $2',
    [campaignId, stepNo],
  );
}

export async function countSteps(campaignId) {
  return (await queryOne(
    'SELECT COUNT(*) AS n FROM sequence_steps WHERE campaign_id = $1',
    [campaignId],
  )).n;
}

/**
 * Replaces the whole step list. Step 1 is the initial send - a plain campaign
 * still gets exactly one row here so the sender worker never special-cases it.
 */
export function replaceSteps(campaignId, steps) {
  return transaction(async (tx) => {
    await tx.execute('DELETE FROM sequence_steps WHERE campaign_id = $1', [campaignId]);

    if (steps.length > 0) {
      await tx.execute(
        `INSERT INTO sequence_steps (campaign_id, step_no, wait_days, subject, preheader, html_body)
         SELECT $1, s.step_no, s.wait_days, s.subject, s.preheader, s.html_body
           FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[])
                AS s(step_no, wait_days, subject, preheader, html_body)`,
        [
          campaignId,
          steps.map((_, i) => i + 1),
          steps.map((s, i) => (i === 0 ? 0 : Number(s.waitDays ?? 3))),
          steps.map((s) => s.subject ?? ''),
          steps.map((s) => s.preheader ?? ''),
          steps.map((s) => s.htmlBody ?? ''),
        ],
      );
    }

    return tx.query('SELECT * FROM sequence_steps WHERE campaign_id = $1 ORDER BY step_no', [campaignId]);
  });
}

// --- Sequence enrollments --------------------------------------------------

export async function enrollContacts(campaignId, contactIds) {
  if (contactIds.length === 0) return 0;
  return execute(
    `INSERT INTO sequence_enrollments (campaign_id, contact_id, current_step, next_run_at, status)
     SELECT $1, id, 0, now(), 'active' FROM unnest($2::int[]) AS id
     ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
    [campaignId, contactIds],
  );
}

export function getEnrollment(campaignId, contactId) {
  return queryOne(
    'SELECT * FROM sequence_enrollments WHERE campaign_id = $1 AND contact_id = $2',
    [campaignId, contactId],
  );
}

export function advanceEnrollment({ campaignId, contactId, stepNo, waitDays, threadMessageId }) {
  // 'minutes' is the testing mode; see sequenceWaitUnit in settings. The unit
  // is chosen in SQL so the wait stays a parameter rather than string-built.
  const unit = getSetting('sequenceWaitUnit') === 'minutes' ? 'minutes' : 'days';

  return execute(
    `UPDATE sequence_enrollments
        SET current_step      = $1,
            next_run_at       = now() + ($2 * CASE WHEN $3 = 'minutes'
                                                   THEN interval '1 minute'
                                                   ELSE interval '1 day' END),
            thread_message_id = COALESCE(thread_message_id, $4),
            updated_at        = now()
      WHERE campaign_id = $5 AND contact_id = $6`,
    [stepNo, Number(waitDays) || 0, unit, threadMessageId ?? null, campaignId, contactId],
  );
}

export function completeEnrollment(campaignId, contactId) {
  return execute(
    `UPDATE sequence_enrollments
        SET status = 'completed', next_run_at = NULL, updated_at = now()
      WHERE campaign_id = $1 AND contact_id = $2`,
    [campaignId, contactId],
  );
}

/**
 * Removes a contact from a sequence. Called when they reply, unsubscribe or
 * bounce - the guarantee that nobody gets a follow-up after they have
 * already answered.
 */
export function exitEnrollment({ campaignId = null, contactId, reason }) {
  // A null campaignId means every active sequence: a reply or unsubscribe is
  // a signal about the person, not about one campaign.
  return execute(
    `UPDATE sequence_enrollments
        SET status = 'exited', exit_reason = $1, next_run_at = NULL, updated_at = now()
      WHERE contact_id = $2
        AND status = 'active'
        AND ($3::int IS NULL OR campaign_id = $3::int)`,
    [reason, contactId, campaignId],
  );
}

/**
 * Enrollments whose next step is due. Exit conditions are re-evaluated by the
 * sequencer as a safety net, in case a reply arrived between scheduling and
 * now.
 */
export function dueEnrollments(limit = 200) {
  return query(
    // k.mailbox_id comes along so the sequencer can stamp the follow-up
    // without a second query per enrollment. It is the campaign's CURRENT
    // mailbox, which is what a follow-up should go out from.
    `SELECT e.*, c.tenant_id, c.email, c.status AS contact_status, k.mailbox_id
       FROM sequence_enrollments e
       JOIN contacts  c ON c.id = e.contact_id
       JOIN campaigns k ON k.id = e.campaign_id
      WHERE e.status = 'active'
        AND e.next_run_at IS NOT NULL
        AND e.next_run_at <= now()
        AND k.status = 'sending'
      ORDER BY e.next_run_at
      LIMIT $1`,
    [limit],
  );
}

export async function enrollmentStats(campaignId) {
  const rows = await query(
    `SELECT status, exit_reason, COUNT(*) AS n
       FROM sequence_enrollments WHERE campaign_id = $1
      GROUP BY status, exit_reason`,
    [campaignId],
  );
  const stats = { active: 0, completed: 0, exited: 0, byReason: {} };
  for (const row of rows) {
    stats[row.status] = (stats[row.status] ?? 0) + row.n;
    if (row.exit_reason) stats.byReason[row.exit_reason] = (stats.byReason[row.exit_reason] ?? 0) + row.n;
  }
  return stats;
}
