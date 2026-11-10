import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  createCampaign, getCampaign, updateCampaign, listCampaigns, setCampaignStatus,
  deleteCampaign, getSteps, replaceSteps, countSteps, enrollContacts,
  enrollmentStats, exitEnrollment, listCategories, createCategory,
  listSubCategories, createSubCategory, subCategoryBelongsTo, getDefaultCategoryId,
} from '../db/repositories/campaigns.js';
import { mailableListMembers } from '../db/repositories/contacts.js';
import {
  queueJobs, campaignJobStats, campaignRecipients, retryJobs, retryableJobs,
} from '../db/repositories/jobs.js';
import { logAction } from '../db/repositories/users.js';
import { lintContent } from '../mail/spam-lint.js';
import { auditMergeFields, describeAudit } from '../lib/merge-fields.js';
import { composeMessage, bodyHasUnsubscribe, sanitizeBody } from '../mail/compose.js';
import { getTransport } from '../mail/transport.js';
import { requireAuth, validate } from '../middleware/index.js';
import { senderStatus } from '../workers/sender.js';
import { queryOne, transaction } from '../db/index.js';

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

const stepSchema = z.object({
  subject: z.string().trim().max(300).default(''),
  preheader: z.string().trim().max(150).default(''),
  htmlBody: z.string().max(200_000).default(''),
  waitDays: z.coerce.number().int().min(0).max(90).default(3),
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  listId: z.coerce.number().int().positive().nullable().optional(),
  // Optional on create/edit: the repository files a missing value under the
  // tenant's default category, so a campaign never ends up uncategorised.
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  // Optional: a sub-category narrows an existing category and may be omitted.
  subCategoryId: z.coerce.number().int().positive().nullable().optional(),
  subject: z.string().trim().max(300).default(''),
  // Shown by mail clients in the inbox list, after the subject. Kept short -
  // most clients cut it off well before 150 characters.
  preheader: z.string().trim().max(150).default(''),
  htmlBody: z.string().max(200_000).default(''),
  fromName: z.string().trim().max(120).default(''),
  fromEmail: z.string().trim().email().or(z.literal('')).default(''),
  replyTo: z.string().trim().email().or(z.literal('')).default(''),
  trackingEnabled: z.boolean().default(false),
  steps: z.array(stepSchema).max(10).default([]),
});

campaignsRouter.get('/', validate(z.object({
  status: z.enum(['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled']).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  subCategoryId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}), 'query'), async (req, res, next) => {
  try {
    const { status, categoryId, subCategoryId, limit, offset } = req.validatedQuery;
    res.json(await listCampaigns({
      status: status ?? null,
      categoryId: categoryId ?? null,
      subCategoryId: subCategoryId ?? null,
      limit,
      offset,
    }));
  } catch (error) {
    next(error);
  }
});

// Must be declared before `/:id`, or Express matches "categories" as an id.
campaignsRouter.get('/categories', async (req, res, next) => {
  try {
    res.json({ categories: await listCategories() });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.post('/categories', validate(z.object({
  name: z.string().trim().min(1).max(60),
})), async (req, res, next) => {
  try {
    res.status(201).json({ category: await createCategory(req.body.name) });
  } catch (error) {
    next(error);
  }
});

// Sub-categories live under a category. Declared before `/:id` for the same
// reason as the category routes above.
campaignsRouter.get('/subcategories', validate(z.object({
  categoryId: z.coerce.number().int().positive(),
}), 'query'), async (req, res, next) => {
  try {
    res.json({ subCategories: await listSubCategories(req.validatedQuery.categoryId) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.get('/subcategories/:categoryId', validate(z.object({
  categoryId: z.coerce.number().int().positive(),
}), 'params'), async (req, res, next) => {
  try {
    res.json({ subCategories: await listSubCategories(req.validatedParams.categoryId) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.post('/subcategories', validate(z.object({
  name: z.string().trim().min(1).max(60),
  categoryId: z.coerce.number().int().positive(),
})), async (req, res, next) => {
  try {
    res.status(201).json({ subCategory: await createSubCategory(req.body.name, req.body.categoryId) });
  } catch (error) {
    // A sub-category under a category that does not exist is the caller's
    // mistake, not a server fault.
    if (error.message === 'Category not found') {
      return res.status(400).json({ error: 'That category does not exist' });
    }
    next(error);
  }
});

campaignsRouter.post('/', validate(campaignSchema), async (req, res, next) => {
  try {
    const body = req.body;

    if (body.trackingEnabled && !env.trackingEnabled) {
      return res.status(400).json({
        error: 'Tracking requires TRACKING_DOMAIN to be configured (a subdomain of your sending domain).',
      });
    }

    const filing = await resolveFiling(body.categoryId ?? null, body.subCategoryId ?? null);
    if (filing.error) return res.status(400).json({ error: filing.error });

    const campaign = await createCampaign({
      name: body.name,
      listId: body.listId ?? null,
      categoryId: filing.categoryId,
      subCategoryId: filing.subCategoryId,
      subject: body.subject,
      preheader: body.preheader,
      htmlBody: sanitizeBody(body.htmlBody),
      fromName: body.fromName,
      fromEmail: body.fromEmail,
      replyTo: body.replyTo,
      trackingEnabled: body.trackingEnabled,
      isSequence: body.steps.length > 1,
      createdBy: req.user.id,
    });

    await replaceSteps(campaign.id, buildSteps(body));
    await logAction({ userId: req.user.id, action: 'campaign.create', entity: 'campaign', entityId: campaign.id });

    res.status(201).json({ campaign: await withDetail(campaign) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.get('/:id', async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: await withDetail(campaign) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.get('/:id/recipients', validate(z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}), 'query'), async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { limit, offset } = req.validatedQuery;
    res.json({ recipients: await campaignRecipients(campaign.id, { limit, offset }) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.put('/:id', validate(campaignSchema), async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'draft') {
      return res.status(409).json({ error: `A campaign that is ${campaign.status} can no longer be edited` });
    }

    const body = req.body;
    if (body.trackingEnabled && !env.trackingEnabled) {
      return res.status(400).json({ error: 'Tracking requires TRACKING_DOMAIN to be configured.' });
    }

    const filing = await resolveFiling(
      body.categoryId ?? campaign.category_id,
      // Explicit null clears the sub-category; omitting the field leaves it.
      body.subCategoryId === undefined ? campaign.sub_category_id : body.subCategoryId,
    );
    if (filing.error) return res.status(400).json({ error: filing.error });

    await updateCampaign(campaign.id, {
      name: body.name,
      list_id: body.listId ?? null,
      category_id: filing.categoryId,
      sub_category_id: filing.subCategoryId,
      subject: body.subject,
      preheader: body.preheader,
      html_body: sanitizeBody(body.htmlBody),
      from_name: body.fromName,
      from_email: body.fromEmail,
      reply_to: body.replyTo,
      tracking_enabled: body.trackingEnabled,
      is_sequence: body.steps.length > 1,
    });
    await replaceSteps(campaign.id, buildSteps(body));

    res.json({ campaign: await withDetail(await getCampaign(campaign.id)) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteCampaign(Number(req.params.id));
    if (!ok) return res.status(409).json({ error: 'Only draft or cancelled campaigns can be deleted' });
    await logAction({ userId: req.user.id, action: 'campaign.delete', entity: 'campaign', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/** Live content score for the composer. */
campaignsRouter.post('/lint', validate(z.object({
  subject: z.string().max(300).default(''),
  htmlBody: z.string().max(200_000).default(''),
})), (req, res) => {
  res.json(lintContent({
    subject: req.body.subject,
    html: req.body.htmlBody,
    sendingDomain: env.SENDING_DOMAIN,
    // The footer is injected at send time, so both are guaranteed present.
    hasUnsubscribe: true,
    hasPostalAddress: env.postalAddressSet,
  }));
});

/** Renders exactly what a given contact would receive. */
campaignsRouter.post('/:id/preview', validate(z.object({
  contactId: z.coerce.number().int().positive().optional(),
  stepNo: z.coerce.number().int().min(1).default(1),
})), async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const steps = await getSteps(campaign.id);
    const step = steps.find((s) => s.step_no === req.body.stepNo) ?? steps[0];
    if (!step) return res.status(400).json({ error: 'Campaign has no steps' });

    const contact = req.body.contactId
      ? await queryOne('SELECT * FROM contacts WHERE id = $1', [req.body.contactId])
      : await sampleContact(campaign);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // A follow-up is sent threaded onto step 1, which is what adds the "Re:"
    // and the In-Reply-To header. Preview has to pass a thread id too, or it
    // shows a subject the recipient will never see - and the rep concludes
    // the follow-ups are not threading.
    const { message } = composeMessage({
      campaign,
      step,
      contact,
      threadMessageId: step.step_no > 1 ? `<preview.step1@${env.SENDING_DOMAIN}>` : null,
    });
    res.json({
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      from: message.from,
      to: message.to,
    });
  } catch (error) {
    next(error);
  }
});

/** Sends one real message to the signed-in rep. */
campaignsRouter.post('/:id/test', validate(z.object({
  to: z.string().trim().email().optional(),
  stepNo: z.coerce.number().int().min(1).default(1),
})), async (req, res, next) => {
  // Express 4 does not forward a throw from an async handler to the error
  // middleware on its own - it just becomes a silently dropped rejection, and
  // with nothing watching for that, Node treats it as fatal and takes the
  // whole process down. Everything below has to go through this catch, not
  // just the sendMail call, or a transient DB hiccup while composing the
  // message kills every other in-flight request along with it.
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const steps = await getSteps(campaign.id);
    const step = steps.find((s) => s.step_no === req.body.stepNo) ?? steps[0];
    if (!step) return res.status(400).json({ error: 'Campaign has no steps' });

    const to = req.body.to ?? req.user.email;
    const { message } = composeMessage({
      campaign,
      step,
      contact: { ...(await sampleContact(campaign)), email: to },
    });
    message.subject = `[TEST] ${message.subject}`;

    await (await getTransport()).sendMail(message);
    await logAction({ userId: req.user.id, action: 'campaign.test_send', entity: 'campaign', entityId: campaign.id, detail: { to } });
    res.json({ ok: true, sentTo: to });
  } catch (error) {
    next(Object.assign(new Error(`Test send failed: ${error.message}`), { status: 502 }));
  }
});

/**
 * Starts a campaign.
 *
 * Content is linted here as the last gate - a campaign missing an
 * unsubscribe link or a postal address, or carrying a shortener, cannot be
 * started at all.
 */
campaignsRouter.post('/:id/start', async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['draft', 'paused', 'scheduled'].includes(campaign.status)) {
      return res.status(409).json({ error: `Campaign is already ${campaign.status}` });
    }
    if (!campaign.list_id) return res.status(400).json({ error: 'Select a contact list first' });

    const steps = await getSteps(campaign.id);
    if (steps.length === 0) return res.status(400).json({ error: 'Campaign has no content' });

    for (const step of steps) {
      const lint = lintContent({
        subject: step.subject || campaign.subject,
        html: step.html_body || campaign.html_body,
        sendingDomain: env.SENDING_DOMAIN,
        hasUnsubscribe: true,
        hasPostalAddress: env.postalAddressSet,
      });
      if (!lint.canSend) {
        return res.status(400).json({
          error: `Step ${step.step_no} cannot be sent`,
          blockers: lint.findings.filter((f) => f.severity === 'block'),
        });
      }
    }

    // Resuming a paused campaign keeps its existing queue.
    if (campaign.status === 'paused') {
      await setCampaignStatus(campaign.id, 'sending');
      await logAction({ userId: req.user.id, action: 'campaign.resume', entity: 'campaign', entityId: campaign.id });
      return res.json({ campaign: await withDetail(await getCampaign(campaign.id)), resumed: true });
    }

    const recipients = await mailableListMembers(campaign.list_id);
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No mailable contacts in that list (all suppressed or inactive)' });
    }

    // Checked here, with the recipient list in hand, because whether a merge
    // field can be filled is a property of the contacts rather than of the
    // copy. An unfillable field would otherwise reach a prospect as literal
    // {{template_syntax}} - worse than no personalisation, since it reveals
    // the mail merge in the opening line.
    const audit = auditMergeFields(steps, recipients);
    if (!audit.ok) {
      return res.status(400).json({
        error: `${audit.contactsAffected} of ${audit.totalContacts} contacts are missing data this campaign uses`,
        detail: 'Fill these in on the contacts, or remove the fields from the copy.',
        fields: describeAudit(audit),
      });
    }

    let queued = 0;
    if (campaign.is_sequence) {
      // Sequences go through enrollments; the sequencer enqueues step 1, so
      // follow-ups and first touches share one code path and one set of limits.
      queued = await enrollContacts(campaign.id, recipients.map((c) => c.id));
    } else {
      queued = await queueJobs(campaign.id, recipients, 1);
    }

    await setCampaignStatus(campaign.id, 'sending');
    await logAction({
      userId: req.user.id,
      action: 'campaign.start',
      entity: 'campaign',
      entityId: campaign.id,
      detail: { recipients: recipients.length, queued, isSequence: campaign.is_sequence },
    });

    res.json({ campaign: await withDetail(await getCampaign(campaign.id)), recipients: recipients.length, queued });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.post('/:id/pause', async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    await setCampaignStatus(campaign.id, 'paused', { pauseReason: `Paused by ${req.user.email}` });
    await logAction({ userId: req.user.id, action: 'campaign.pause', entity: 'campaign', entityId: campaign.id });
    res.json({ campaign: await withDetail(await getCampaign(campaign.id)) });
  } catch (error) {
    next(error);
  }
});

campaignsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // One transaction: a cancel that stopped the queue but left enrollments
    // active would keep mailing follow-ups to a campaign the rep has stopped.
    await transaction(async (tx) => {
      await tx.execute(
        "UPDATE campaigns SET status = 'cancelled', pause_reason = NULL, updated_at = now() WHERE id = $1",
        [campaign.id],
      );
      await tx.execute(
        `UPDATE send_jobs SET status = 'skipped', skip_reason = 'campaign_cancelled'
          WHERE campaign_id = $1 AND status = 'queued'`,
        [campaign.id],
      );
      await tx.execute(
        `UPDATE sequence_enrollments
            SET status = 'exited', exit_reason = 'stopped', next_run_at = NULL, updated_at = now()
          WHERE campaign_id = $1 AND status = 'active'`,
        [campaign.id],
      );
    });

    await logAction({ userId: req.user.id, action: 'campaign.cancel', entity: 'campaign', entityId: campaign.id });
    res.json({ campaign: await withDetail(await getCampaign(campaign.id)) });
  } catch (error) {
    next(error);
  }
});

/**
 * Retries sends that failed or are sitting out a backoff.
 *
 * Without this a transient cause - wrong password, provider outage - leaves
 * the queue stalled behind an exponential backoff that can run to hours,
 * with no way to say "that is fixed now, go again".
 *
 * POST /:id/retry          every retryable job
 * POST /:id/retry/:jobId   one of them
 */
campaignsRouter.post('/:id/retry/:jobId?', async (req, res, next) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const jobId = req.params.jobId ? Number(req.params.jobId) : null;
    if (jobId !== null && !Number.isInteger(jobId)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    const retried = await retryJobs(campaign.id, jobId);
    if (retried === 0) {
      return res.status(409).json({ error: 'Nothing to retry - no failed or errored messages.' });
    }

    // A campaign that ran to completion needs reopening, or the sender skips
    // it however many jobs are queued.
    if (['completed', 'paused'].includes(campaign.status)) {
      await setCampaignStatus(campaign.id, 'sending');
    }

    await logAction({
      userId: req.user.id,
      action: 'campaign.retry',
      entity: 'campaign',
      entityId: campaign.id,
      detail: { retried, jobId },
    });

    res.json({ retried, campaign: await withDetail(await getCampaign(campaign.id)) });
  } catch (error) {
    next(error);
  }
});

/** Manually remove one contact from a running sequence. */
campaignsRouter.post('/:id/stop-contact', validate(z.object({
  contactId: z.coerce.number().int().positive(),
})), async (req, res, next) => {
  try {
    const exited = await exitEnrollment({
      campaignId: Number(req.params.id),
      contactId: req.body.contactId,
      reason: 'stopped',
    });
    res.json({ exited });
  } catch (error) {
    next(error);
  }
});

// --- Helpers ---------------------------------------------------------------

/**
 * A campaign always has at least one step, so the sender worker never has to
 * special-case "plain campaign" against "sequence".
 */
function buildSteps(body) {
  if (body.steps.length > 0) {
    return body.steps.map((step, index) => ({
      subject: step.subject || (index === 0 ? body.subject : ''),
      preheader: step.preheader || (index === 0 ? body.preheader : ''),
      htmlBody: step.htmlBody || (index === 0 ? body.htmlBody : ''),
      waitDays: index === 0 ? 0 : step.waitDays,
    }));
  }
  return [{ subject: body.subject, preheader: body.preheader, htmlBody: body.htmlBody, waitDays: 0 }];
}

/**
 * Resolves the category/sub-category pair a campaign will be filed under.
 *
 * Both ids come from the client, so both are checked here rather than left to
 * the foreign key: an unknown id would otherwise surface as a constraint
 * violation and a 500, when it is plainly a bad request. The pair is checked
 * too - a sub-category under a different category would file the campaign
 * somewhere it cannot be found again.
 */
async function resolveFiling(categoryId, subCategoryId) {
  const resolved = categoryId ?? await getDefaultCategoryId();

  const category = await queryOne(
    'SELECT id FROM campaign_categories WHERE id = $1 AND tenant_id = 1',
    [resolved],
  );
  if (!category) return { error: 'That category does not exist' };

  if (!await subCategoryBelongsTo(subCategoryId ?? null, resolved)) {
    return { error: 'That sub-category does not belong to the selected category' };
  }

  return { categoryId: resolved, subCategoryId: subCategoryId ?? null };
}

async function withDetail(campaign) {
  // Six independent reads for one campaign page; issued together rather than
  // in series, since each is now a network round trip.
  const [steps, stepCount, stats, retryable, enrollments, engagement] = await Promise.all([
    getSteps(campaign.id),
    countSteps(campaign.id),
    campaignJobStats(campaign.id),
    retryableJobs(campaign.id),
    campaign.is_sequence ? enrollmentStats(campaign.id) : null,
    engagementStats(campaign.id),
  ]);

  return {
    ...campaign,
    steps,
    stepCount,
    stats,
    retryable: retryable.length,
    enrollments,
    engagement,
    hasUnsubscribeInBody: bodyHasUnsubscribe(campaign.html_body),
    // Why the queue is or is not moving. Without this the page shows work
    // queued and nothing happening, with no way to tell that the send
    // window simply closed for the evening.
    sender: await senderStatus(),
  };
}

/**
 * Headline numbers exclude bot traffic; the raw figure is kept alongside.
 *
 * Postgres lower-cases an unquoted alias, so `botHits` would come back as
 * `bothits` - hence the quoted alias.
 */
function engagementStats(campaignId) {
  return queryOne(
    `SELECT
       (SELECT COUNT(DISTINCT contact_id) FROM tracking_events
         WHERE campaign_id = $1 AND event_type = 'open'  AND is_bot = FALSE) AS opens,
       (SELECT COUNT(DISTINCT contact_id) FROM tracking_events
         WHERE campaign_id = $1 AND event_type = 'click' AND is_bot = FALSE) AS clicks,
       (SELECT COUNT(*) FROM tracking_events
         WHERE campaign_id = $1 AND is_bot = TRUE)                           AS "botHits",
       (SELECT COUNT(*) FROM replies      WHERE campaign_id = $1)            AS replies,
       -- Recipients of this campaign who are now unsubscribed, rather than
       -- only those whose opt-out carried this campaign's id. An opt-out
       -- that arrived by another route - a test send, the mailto option, a
       -- manual suppression - still means this recipient is gone, and
       -- reporting zero while the suppression list shows them is just
       -- confusing.
       (SELECT COUNT(DISTINCT j.contact_id) FROM send_jobs j
          JOIN contacts c ON c.id = j.contact_id
         WHERE j.campaign_id = $1 AND c.status = 'unsubscribed')             AS unsubscribes,
       (SELECT COUNT(*) FROM bounces      WHERE campaign_id = $1)            AS bounces`,
    [campaignId],
  );
}

async function sampleContact(campaign) {
  const fromList = campaign.list_id
    ? await queryOne(
      `SELECT c.* FROM contacts c
         JOIN list_contacts lc ON lc.contact_id = c.id
        WHERE lc.list_id = $1 LIMIT 1`,
      [campaign.list_id],
    )
    : null;

  return fromList ?? {
    // Not a real row: null so the unsubscribe token carries no id
    // rather than a phantom 0 that no table can satisfy.
    id: null,
    email: 'sample@example.com',
    first_name: 'Sample',
    last_name: 'Prospect',
    company: 'Sample Company',
    custom_fields: {},
  };
}
