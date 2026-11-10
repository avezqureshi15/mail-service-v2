import { Router } from 'express';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';

import {
  upsertContact, upsertManyContacts, listContacts, deleteContact, countByStatus,
  findByEmail as findContactByEmail,
  createList, listLists, getList, findListByName, addManyToList,
  removeFromList, deleteList, setStatus,
} from '../db/repositories/contacts.js';
import {
  listSuppressions, removeSuppression, suppress, suppressedSubset, normaliseEmail,
} from '../db/repositories/suppressions.js';
import { logAction } from '../db/repositories/users.js';
import { validateRows, REASON_LABELS } from '../lib/email-validation.js';
import { requireAuth, validate } from '../middleware/index.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

// In memory, with a ceiling - a CSV this size is already ~100k rows, far more
// than the volume this service is built for.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const listQuery = z.object({
  search: z.string().trim().max(200).default(''),
  listId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'unsubscribed', 'bounced', 'complained']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

contactsRouter.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { search, listId, status, limit, offset } = req.validatedQuery;
    const [page, counts] = await Promise.all([
      listContacts({ search, listId: listId ?? null, status: status ?? null, limit, offset }),
      countByStatus(),
    ]);
    res.json({ contacts: page.rows, total: page.total, counts });
  } catch (error) {
    next(error);
  }
});

contactsRouter.get('/stats', async (_req, res, next) => {
  try {
    res.json({ counts: await countByStatus() });
  } catch (error) {
    next(error);
  }
});

const manualContact = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().max(100).default(''),
  lastName: z.string().trim().max(100).default(''),
  company: z.string().trim().max(200).default(''),
  listId: z.coerce.number().int().positive().optional(),
});

contactsRouter.post('/', validate(manualContact), async (req, res, next) => {
  try {
    const { email, firstName, lastName, company, listId } = req.body;
    const contact = await upsertContact({ email, firstName, lastName, company, source: 'manual' });
    if (listId) await addManyToList(listId, [contact.id]);
    await logAction({ userId: req.user.id, action: 'contact.create', entity: 'contact', entityId: contact.id });
    res.status(201).json({ contact });
  } catch (error) {
    next(error);
  }
});

contactsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteContact(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Contact not found' });
    await logAction({ userId: req.user.id, action: 'contact.delete', entity: 'contact', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * CSV import.
 *
 * Returns a validation report rather than silently accepting everything: the
 * rep sees list quality before any of it is mailed. Nothing is written until
 * they confirm, which is the second call below.
 */
contactsRouter.post('/import/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

    const records = parseCsv(req.file.buffer, {
      columns: (header) => header.map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });

    if (records.length === 0) return res.status(400).json({ error: 'CSV contains no data rows' });
    if (records.length > 50_000) {
      return res.status(400).json({ error: 'CSV exceeds 50,000 rows. Split it into smaller files.' });
    }

    const mapping = resolveMapping(records[0], req.body);
    if (!mapping.email) {
      return res.status(400).json({
        error: 'Could not find an email column',
        columns: Object.keys(records[0]),
      });
    }

    const rows = records.map((record) => normaliseRecord(record, mapping));
    const excludeRoleAccounts = req.body.excludeRoleAccounts !== 'false';
    const report = await validateRows(rows, { excludeRoleAccounts });

    // Anyone already unsubscribed or bounced must never be re-added by an
    // import - that is how a suppression list quietly stops working.
    const alreadySuppressed = await suppressedSubset(
      [...report.accepted, ...report.flagged].map((entry) => entry.email),
    );
    for (const bucket of ['accepted', 'flagged']) {
      report[bucket] = report[bucket].filter((entry) => {
        if (!alreadySuppressed.has(entry.email)) return true;
        report.rejected.push({ ...entry, reason: 'already_suppressed' });
        return false;
      });
    }

    res.json({
      columns: Object.keys(records[0]),
      mapping,
      totalRows: records.length,
      summary: {
        accepted: report.accepted.length,
        flagged: report.flagged.length,
        rejected: report.rejected.length,
      },
      reasonLabels: REASON_LABELS,
      accepted: report.accepted.slice(0, 20).map(summarise),
      flagged: report.flagged.map(summarise),
      rejected: report.rejected.map(summarise),
      // Echoed back to the commit call so the file is parsed only once.
      payload: {
        accepted: report.accepted.map(toPayload),
        flagged: report.flagged.map(toPayload),
      },
    });
  } catch (error) {
    if (error.code?.startsWith?.('CSV_')) {
      return res.status(400).json({ error: `Could not parse CSV: ${error.message}` });
    }
    next(error);
  }
});

const commitSchema = z.object({
  listName: z.string().trim().min(1).max(120),
  includeFlagged: z.boolean().default(false),
  contacts: z
    .array(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        firstName: z.string().max(100).default(''),
        lastName: z.string().max(100).default(''),
        company: z.string().max(200).default(''),
        customFields: z.record(z.string()).default({}),
        isRole: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(50_000),
});

contactsRouter.post('/import/commit', validate(commitSchema), async (req, res, next) => {
  try {
    const { listName, includeFlagged, contacts } = req.body;

    const list = await findListByName(listName)
      ?? await createList({ name: listName, createdBy: req.user.id });

    const toImport = includeFlagged ? contacts : contacts.filter((c) => !c.isRole);

    const ids = await upsertManyContacts(toImport.map((entry) => ({
      email: entry.email,
      firstName: entry.firstName,
      lastName: entry.lastName,
      company: entry.company,
      customFields: entry.customFields,
      isRoleAccount: entry.isRole,
      source: 'import',
    })));

    const added = await addManyToList(list.id, ids);

    await logAction({
      userId: req.user.id,
      action: 'contact.import',
      entity: 'list',
      entityId: list.id,
      detail: { listName, imported: ids.length, addedToList: added },
    });

    res.json({ list, imported: ids.length, addedToList: added });
  } catch (error) {
    next(error);
  }
});

// --- Lists -----------------------------------------------------------------

export const listsRouter = Router();
listsRouter.use(requireAuth);

listsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ lists: await listLists() });
  } catch (error) {
    next(error);
  }
});

listsRouter.post('/', validate(z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
})), async (req, res, next) => {
  try {
    if (await findListByName(req.body.name)) {
      return res.status(409).json({ error: 'A list with that name already exists' });
    }
    const list = await createList({ ...req.body, createdBy: req.user.id });
    res.status(201).json({ list });
  } catch (error) {
    next(error);
  }
});

listsRouter.get('/:id', async (req, res, next) => {
  try {
    const list = await getList(Number(req.params.id));
    if (!list) return res.status(404).json({ error: 'List not found' });
    res.json({ list });
  } catch (error) {
    next(error);
  }
});

listsRouter.delete('/:id/contacts/:contactId', async (req, res, next) => {
  try {
    await removeFromList(Number(req.params.id), Number(req.params.contactId));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

listsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteList(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'List not found' });
    await logAction({ userId: req.user.id, action: 'list.delete', entity: 'list', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// --- Suppressions ----------------------------------------------------------

export const suppressionsRouter = Router();
suppressionsRouter.use(requireAuth);

suppressionsRouter.get('/', validate(z.object({
  search: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}), 'query'), async (req, res, next) => {
  try {
    const { search, limit, offset } = req.validatedQuery;
    res.json(await listSuppressions({ search, limit, offset }));
  } catch (error) {
    next(error);
  }
});

suppressionsRouter.post('/', validate(z.object({
  email: z.string().trim().toLowerCase().email(),
  notes: z.string().trim().max(500).default(''),
})), async (req, res, next) => {
  try {
    const added = await suppress({
      email: req.body.email,
      reason: 'manual',
      source: `user:${req.user.email}`,
      notes: req.body.notes,
    });
    await setStatusByEmailIfKnown(req.body.email);
    await logAction({ userId: req.user.id, action: 'suppression.add', detail: { email: req.body.email } });
    res.status(added ? 201 : 200).json({ added });
  } catch (error) {
    next(error);
  }
});

/**
 * Removing a suppression is an explicit opt-in override, always attributed.
 */
suppressionsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await removeSuppression(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Suppression not found' });
    await logAction({ userId: req.user.id, action: 'suppression.remove', entityId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// --- Helpers ---------------------------------------------------------------

const EMAIL_ALIASES = ['email', 'email_address', 'e-mail', 'mail', 'work_email', 'contact_email'];
const FIRST_ALIASES = ['first_name', 'firstname', 'first', 'given_name', 'fname'];
const LAST_ALIASES = ['last_name', 'lastname', 'last', 'surname', 'family_name', 'lname'];
const COMPANY_ALIASES = ['company', 'company_name', 'organisation', 'organization', 'org', 'account', 'employer'];

function pick(record, aliases, override) {
  if (override && override in record) return override;
  return aliases.find((alias) => alias in record) ?? null;
}

function resolveMapping(firstRecord, body = {}) {
  return {
    email: pick(firstRecord, EMAIL_ALIASES, body.emailColumn),
    firstName: pick(firstRecord, FIRST_ALIASES, body.firstNameColumn),
    lastName: pick(firstRecord, LAST_ALIASES, body.lastNameColumn),
    company: pick(firstRecord, COMPANY_ALIASES, body.companyColumn),
  };
}

const RESERVED = new Set(['first_name', 'last_name', 'full_name', 'company', 'email']);

function normaliseRecord(record, mapping) {
  const customFields = {};
  for (const [key, value] of Object.entries(record)) {
    if (Object.values(mapping).includes(key)) continue;
    if (RESERVED.has(key)) continue;
    if (value === '' || value === null || value === undefined) continue;
    // Cap stored size so one oversized CSV cell cannot bloat every row.
    customFields[key] = String(value).slice(0, 500);
  }

  let name = { first: '', last: '' };
  if (!mapping.firstName && record.name) {
    const parts = String(record.name).trim().split(/\s+/);
    name = { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
  }

  return {
    email: record[mapping.email] ?? '',
    firstName: (mapping.firstName ? record[mapping.firstName] : name.first) ?? '',
    lastName: (mapping.lastName ? record[mapping.lastName] : name.last) ?? '',
    company: (mapping.company ? record[mapping.company] : '') ?? '',
    customFields,
  };
}

function summarise(entry) {
  return { email: entry.email, reason: entry.reason, company: entry.row?.company ?? '' };
}

function toPayload(entry) {
  return {
    email: entry.email,
    firstName: entry.row?.firstName ?? '',
    lastName: entry.row?.lastName ?? '',
    company: entry.row?.company ?? '',
    customFields: entry.row?.customFields ?? {},
    isRole: Boolean(entry.parsed?.isRole),
  };
}

/** Keeps the contact row in step when an address is suppressed by hand. */
async function setStatusByEmailIfKnown(email) {
  const contact = await findContactByEmail(normaliseEmail(email));
  if (contact) await setStatus(contact.id, 'unsubscribed');
}
