// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import {
  createCampaign, getCampaign, updateCampaign, listCampaigns,
  createCategory, listSubCategories, createSubCategory, subCategoryBelongsTo,
} from '../src/db/repositories/campaigns.js';

before(setupTestSchema);
after(teardownTestSchema);

const uniq = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('sub-category names are trimmed and unique within a category', async () => {
  const category = await createCategory(uniq('Parent'));
  const base = uniq('Engineering');

  const first = await createSubCategory(`  ${base}  `, category.id);
  const second = await createSubCategory(base.toUpperCase(), category.id);

  assert.equal(first.id, second.id);
  assert.equal(first.name, base);
  assert.equal(first.category_id, category.id);

  const matches = (await listSubCategories(category.id))
    .filter((sc) => sc.name.toLowerCase() === base.toLowerCase());
  assert.equal(matches.length, 1);
});

test('the same sub-category name may exist under different categories', async () => {
  const name = uniq('Shared');
  const catA = await createCategory(uniq('A'));
  const catB = await createCategory(uniq('B'));

  const a = await createSubCategory(name, catA.id);
  const b = await createSubCategory(name, catB.id);

  assert.notEqual(a.id, b.id);
  assert.equal(a.name, name);
  assert.equal(b.name, name);
});

test('listSubCategories only returns sub-categories of the given category', async () => {
  const catA = await createCategory(uniq('OnlyA'));
  const catB = await createCategory(uniq('OnlyB'));
  const a = await createSubCategory(uniq('a-sub'), catA.id);
  const b = await createSubCategory(uniq('b-sub'), catB.id);

  const rows = await listSubCategories(catA.id);
  assert.ok(rows.find((r) => r.id === a.id), 'own sub-category should be listed');
  assert.ok(!rows.find((r) => r.id === b.id), 'other category sub-category must not be listed');
});

test('createSubCategory rejects a category that does not exist', async () => {
  await assert.rejects(
    () => createSubCategory(uniq('orphan'), 999_999),
    /Category not found/,
  );
});

test('a campaign stores its sub-category and exposes its name', async () => {
  const category = await createCategory(uniq('Store'));
  const subCategory = await createSubCategory(uniq('Stored'), category.id);

  const campaign = await createCampaign({
    name: uniq('campaign'),
    categoryId: category.id,
    subCategoryId: subCategory.id,
  });

  assert.equal(campaign.sub_category_id, subCategory.id);
  assert.equal(campaign.sub_category_name, subCategory.name);

  const reloaded = await getCampaign(campaign.id);
  assert.equal(reloaded.sub_category_id, subCategory.id);
  assert.equal(reloaded.sub_category_name, subCategory.name);
});

test('filtering by sub-category returns only that group', async () => {
  const category = await createCategory(uniq('Filter'));
  const subA = await createSubCategory(uniq('sub-a'), category.id);
  const subB = await createSubCategory(uniq('sub-b'), category.id);

  const a = await createCampaign({ name: uniq('a'), categoryId: category.id, subCategoryId: subA.id });
  const b = await createCampaign({ name: uniq('b'), categoryId: category.id, subCategoryId: subB.id });

  const { rows, total } = await listCampaigns({ subCategoryId: subA.id, limit: 100 });

  assert.equal(total, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, a.id);
  assert.notEqual(rows[0].id, b.id);
  assert.equal(rows[0].sub_category_name, subA.name);
});

test('filtering by category and sub-category together narrows the result', async () => {
  const category = await createCategory(uniq('Combo'));
  const otherCategory = await createCategory(uniq('OtherCombo'));
  const sub = await createSubCategory(uniq('combo-sub'), category.id);

  const match = await createCampaign({ name: uniq('match'), categoryId: category.id, subCategoryId: sub.id });
  await createCampaign({ name: uniq('wrong-cat'), categoryId: otherCategory.id, subCategoryId: sub.id });

  const { rows } = await listCampaigns({ categoryId: category.id, subCategoryId: sub.id, limit: 100 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, match.id);
});

test('a campaign without a sub-category still lists', async () => {
  const category = await createCategory(uniq('NoSub'));
  const campaign = await createCampaign({ name: uniq('no-sub'), categoryId: category.id });

  assert.equal(campaign.sub_category_id, null);
  assert.equal(campaign.sub_category_name, null);

  const { rows } = await listCampaigns({ categoryId: category.id, limit: 100 });
  assert.ok(rows.find((r) => r.id === campaign.id));
});

test('updateCampaign can replace and clear the sub-category', async () => {
  const category = await createCategory(uniq('Update'));
  const first = await createSubCategory(uniq('first'), category.id);
  const second = await createSubCategory(uniq('second'), category.id);
  const campaign = await createCampaign({
    name: uniq('campaign'),
    categoryId: category.id,
    subCategoryId: first.id,
  });

  const replaced = await updateCampaign(campaign.id, { sub_category_id: second.id });
  assert.equal(replaced.sub_category_id, second.id);
  assert.equal(replaced.sub_category_name, second.name);

  const cleared = await updateCampaign(campaign.id, { sub_category_id: null });
  assert.equal(cleared.sub_category_id, null);
  assert.equal(cleared.sub_category_name, null);
});

test('listSubCategories counts campaigns per sub-category', async () => {
  const category = await createCategory(uniq('CountSub'));
  const sub = await createSubCategory(uniq('counted'), category.id);

  await createCampaign({ name: uniq('a'), categoryId: category.id, subCategoryId: sub.id });
  await createCampaign({ name: uniq('b'), categoryId: category.id, subCategoryId: sub.id });

  const row = (await listSubCategories(category.id)).find((r) => r.id === sub.id);
  assert.ok(row, 'sub-category should be listed');
  assert.equal(row.count, 2);
});

/**
 * The pairing check the create and update routes rely on to answer 400
 * rather than letting a foreign key turn a bad request into a 500.
 */
test('subCategoryBelongsTo only accepts a pair under the same category', async () => {
  const category = await createCategory(uniq('Owns'));
  const other = await createCategory(uniq('Foreign'));
  const sub = await createSubCategory(uniq('owned'), category.id);

  assert.equal(await subCategoryBelongsTo(sub.id, category.id), true);
  assert.equal(await subCategoryBelongsTo(sub.id, other.id), false);
  assert.equal(await subCategoryBelongsTo(999_999, category.id), false);
  // No sub-category at all is a valid filing, not a mismatch.
  assert.equal(await subCategoryBelongsTo(null, category.id), true);
});
