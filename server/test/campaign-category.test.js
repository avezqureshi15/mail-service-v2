// Must come first: points the app at a scratch schema before env.js reads
// the configuration. See the helper for why.
import './helpers/test-db.js';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestSchema, teardownTestSchema } from './helpers/test-db.js';
import {
  createCampaign, updateCampaign, listCampaigns,
  createCategory, listCategories, getDefaultCategoryId,
} from '../src/db/repositories/campaigns.js';

before(setupTestSchema);
after(teardownTestSchema);

const uniq = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('a campaign keeps its category after updateCampaign (UPDATABLE regression)', async () => {
  const cat = await createCategory(uniq('Keep'));
  const campaign = await createCampaign({ name: uniq('campaign'), categoryId: cat.id });
  assert.equal(campaign.category_id, cat.id);

  const other = await createCategory(uniq('Swap'));
  const updated = await updateCampaign(campaign.id, { category_id: other.id });
  assert.equal(updated.category_id, other.id);
  assert.equal(updated.category_name, other.name);
});

test('category names are trimmed and unique case-insensitively', async () => {
  const base = uniq('Sales');
  const first = await createCategory(`  ${base}  `);
  const second = await createCategory(base.toUpperCase());

  assert.equal(first.id, second.id);
  assert.equal(first.name, base);

  const matches = (await listCategories())
    .filter((c) => c.name.toLowerCase() === base.toLowerCase());
  assert.equal(matches.length, 1);
});

test('listCategories counts campaigns per category', async () => {
  const cat = await createCategory(uniq('Counted'));
  await createCampaign({ name: uniq('a'), categoryId: cat.id });
  await createCampaign({ name: uniq('b'), categoryId: cat.id });

  const row = (await listCategories()).find((c) => c.id === cat.id);
  assert.ok(row, 'category should be listed');
  assert.equal(row.count, 2);
});

test('filtering by category returns only that category', async () => {
  const catA = await createCategory(uniq('A'));
  const catB = await createCategory(uniq('B'));
  const a = await createCampaign({ name: uniq('a'), categoryId: catA.id });
  const b = await createCampaign({ name: uniq('b'), categoryId: catB.id });

  const { rows, total } = await listCampaigns({ categoryId: catA.id, limit: 100 });

  assert.equal(total, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, a.id);
  assert.notEqual(rows[0].id, b.id);
});

test('a campaign created without a category is filed under the default', async () => {
  const campaign = await createCampaign({ name: uniq('no-cat') });

  assert.ok(campaign.category_id, 'category_id must never be null');
  assert.equal(campaign.category_id, await getDefaultCategoryId());
  assert.equal(campaign.category_name, 'Uncategorised');

  const { rows } = await listCampaigns({ status: 'draft', limit: 100 });
  assert.ok(rows.find((r) => r.id === campaign.id), 'campaign should still list');
});
