import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldsUsedIn, fieldsUsedInSteps, auditMergeFields, describeAudit,
} from '../src/lib/merge-fields.js';

/**
 * No database: this is pure analysis of copy against contacts, and keeping
 * it that way means it runs in milliseconds and cannot be broken by schema
 * changes.
 */

const contact = (over = {}) => ({
  id: 1, email: 'dana@abc.test', first_name: 'Dana', last_name: 'Prospect',
  company: 'ABC', custom_fields: '{}', ...over,
});

test('finds each field once, in order', () => {
  assert.deepEqual(
    fieldsUsedIn('Hi {{first_name}}, {{company}} and {{first_name}} again'),
    ['first_name', 'company'],
  );
});

test('ignores text that only looks like a field', () => {
  assert.deepEqual(fieldsUsedIn('a { b } c {{ }} d {{not-a-field}}'), []);
});

test('unsubscribe_url is not treated as a contact field', () => {
  // The composer substitutes it after merging, so it is never unresolved.
  const steps = [{ subject: '', html_body: '<a href="{{unsubscribe_url}}">out</a>' }];
  assert.deepEqual(fieldsUsedInSteps(steps), []);
  assert.equal(auditMergeFields(steps, [contact()]).ok, true);
});

test('collects fields from subjects as well as bodies', () => {
  const steps = [{ subject: 'About {{role_examples}}', html_body: 'Hi {{first_name}}' }];
  assert.deepEqual(fieldsUsedInSteps(steps).sort(), ['first_name', 'role_examples']);
});

test('built-in fields are always fillable', () => {
  const steps = [{ subject: '', html_body: 'Hi {{first_name}} {{last_name}} {{full_name}} {{company}} {{email}}' }];
  assert.equal(auditMergeFields(steps, [contact()]).ok, true);
});

test('a missing custom field blocks the campaign', () => {
  const steps = [{ subject: '', html_body: 'I saw {{observation}}' }];
  const audit = auditMergeFields(steps, [contact()]);

  assert.equal(audit.ok, false);
  assert.equal(audit.fields.length, 1);
  assert.equal(audit.fields[0].field, 'observation');
  assert.equal(audit.fields[0].missing, 1);
  assert.equal(audit.contactsAffected, 1);
});

test('a blank custom field blocks it too', () => {
  // "I noticed that ." reads as broken just as plainly as the raw syntax.
  const steps = [{ subject: '', html_body: 'I noticed that {{observation}}.' }];
  const audit = auditMergeFields(steps, [contact({ custom_fields: '{"observation":"   "}' })]);

  assert.equal(audit.ok, false);
  assert.equal(audit.fields[0].blank, 1);
  assert.equal(audit.fields[0].missing, 0);
});

test('a filled custom field passes', () => {
  const steps = [{ subject: '', html_body: 'I saw {{observation}}' }];
  const filled = contact({ custom_fields: '{"observation":"your careers page lists three Java roles"}' });
  assert.equal(auditMergeFields(steps, [filled]).ok, true);
});

test('custom_fields already parsed into an object is handled', () => {
  // Postgres returns jsonb as an object, not a string.
  const steps = [{ subject: '', html_body: '{{observation}}' }];
  const filled = contact({ custom_fields: { observation: 'hiring across three stacks' } });
  assert.equal(auditMergeFields(steps, [filled]).ok, true);
});

test('counts how many contacts each field affects, and names examples', () => {
  const steps = [{ subject: '', html_body: '{{observation}} and {{role_examples}}' }];
  const contacts = [
    contact({ id: 1, email: 'a@x.test', custom_fields: '{"observation":"x","role_examples":"y"}' }),
    contact({ id: 2, email: 'b@x.test', custom_fields: '{"role_examples":"y"}' }),
    contact({ id: 3, email: 'c@x.test', custom_fields: '{}' }),
  ];

  const audit = auditMergeFields(steps, contacts);

  assert.equal(audit.ok, false);
  assert.equal(audit.totalContacts, 3);
  // b and c lack observation; c also lacks role_examples.
  assert.equal(audit.contactsAffected, 2);

  const observation = audit.fields.find((f) => f.field === 'observation');
  assert.equal(observation.contacts, 2);
  assert.deepEqual(observation.examples, ['b@x.test', 'c@x.test']);

  // Worst offender first, so the message leads with the biggest problem.
  assert.equal(audit.fields[0].field, 'observation');
});

test('examples are capped so the error stays readable', () => {
  const steps = [{ subject: '', html_body: '{{observation}}' }];
  const many = Array.from({ length: 50 }, (_, i) => contact({ id: i, email: `p${i}@x.test` }));
  const audit = auditMergeFields(steps, many);

  assert.equal(audit.fields[0].contacts, 50);
  assert.equal(audit.fields[0].examples.length, 3);
});

test('copy with no merge fields is fine', () => {
  assert.equal(auditMergeFields([{ subject: 'Hello', html_body: '<p>No fields</p>' }], [contact()]).ok, true);
});

test('the description says what to fix and where', () => {
  const steps = [{ subject: '', html_body: '{{observation}}' }];
  const lines = describeAudit(auditMergeFields(steps, [contact()]));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /\{\{observation\}\}/);
  assert.match(lines[0], /1 missing of 1 contacts/);
  assert.match(lines[0], /dana@abc\.test/);
});
