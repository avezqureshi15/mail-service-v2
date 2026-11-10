/**
 * Checks that every merge field in a campaign can actually be filled for
 * every contact it will be sent to.
 *
 * The renderer leaves an unknown field exactly as it found it:
 *
 *   renderMergeFields('hiring {{tech_stack}}', contact)  ->  'hiring {{tech_stack}}'
 *
 * That is the right behaviour for a renderer - silently deleting text would
 * be worse - but it means one missing column in a CSV sends literal template
 * syntax to a prospect. In cold outreach that is more damaging than no
 * personalisation at all: it advertises that the "personal" email is a mail
 * merge, in the first sentence.
 *
 * A blank value is treated as missing for the same reason. `{{observation}}`
 * resolving to an empty string turns "I noticed that {{observation}}." into
 * "I noticed that ." - broken in a different way, equally visible.
 *
 * The check is deliberately run at campaign start rather than at save time:
 * only at start is the recipient list known, and the list is what determines
 * whether a field can be filled.
 */

/**
 * Always present on every contact. `renderMergeFields` defaults each of
 * these to an empty string, so they can never be left unresolved - though
 * they can still be blank, which this reports.
 */
export const BUILT_IN_FIELDS = ['first_name', 'last_name', 'full_name', 'company', 'email'];

/** Substituted later by the composer, not by the merge-field renderer. */
export const INJECTED_FIELDS = ['unsubscribe_url'];

const FIELD_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every merge field named in a piece of text, deduplicated, in order. */
export function fieldsUsedIn(text) {
  const found = [];
  for (const [, name] of String(text ?? '').matchAll(FIELD_PATTERN)) {
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** The fields a campaign's steps reference across subjects and bodies. */
export function fieldsUsedInSteps(steps) {
  const all = [];
  for (const step of steps) {
    for (const name of [...fieldsUsedIn(step.subject), ...fieldsUsedIn(step.html_body)]) {
      if (!all.includes(name)) all.push(name);
    }
  }
  return all.filter((name) => !INJECTED_FIELDS.includes(name));
}

function customFieldsOf(contact) {
  const raw = contact?.custom_fields;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function valueFor(contact, field) {
  if (field === 'full_name') {
    return [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  }
  if (BUILT_IN_FIELDS.includes(field)) return contact[field];
  return customFieldsOf(contact)[field];
}

/**
 * Audits a campaign's steps against the contacts it would be sent to.
 *
 * @param {Array} steps    Campaign steps, with `subject` and `html_body`.
 * @param {Array} contacts The recipients, as stored.
 * @returns {{ok: boolean, fields: Array, contactsAffected: number, totalContacts: number}}
 *   `fields` lists each problem field with how many contacts it affects and
 *   up to three example addresses, so the fix is a CSV edit rather than a
 *   hunt.
 */
export function auditMergeFields(steps, contacts) {
  const used = fieldsUsedInSteps(steps);
  const totalContacts = contacts.length;

  if (used.length === 0 || totalContacts === 0) {
    return { ok: true, fields: [], contactsAffected: 0, totalContacts };
  }

  const problems = new Map();
  const affected = new Set();

  for (const contact of contacts) {
    for (const field of used) {
      const value = valueFor(contact, field);
      const missing = value === undefined || value === null;
      const blank = !missing && String(value).trim() === '';
      if (!missing && !blank) continue;

      if (!problems.has(field)) {
        problems.set(field, { field, missing: 0, blank: 0, examples: [] });
      }
      const entry = problems.get(field);
      if (missing) entry.missing += 1; else entry.blank += 1;
      if (entry.examples.length < 3) entry.examples.push(contact.email);
      affected.add(contact.id ?? contact.email);
    }
  }

  const fields = [...problems.values()]
    .map((p) => ({ ...p, contacts: p.missing + p.blank }))
    .sort((a, b) => b.contacts - a.contacts);

  return {
    ok: fields.length === 0,
    fields,
    contactsAffected: affected.size,
    totalContacts,
  };
}

/** A one-line explanation per problem field, for the API error body. */
export function describeAudit(audit) {
  return audit.fields.map((f) => {
    const parts = [];
    if (f.missing) parts.push(`${f.missing} missing`);
    if (f.blank) parts.push(`${f.blank} blank`);
    return `{{${f.field}}} - ${parts.join(', ')} of ${audit.totalContacts} contacts (e.g. ${f.examples.join(', ')})`;
  });
}
