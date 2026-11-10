#!/usr/bin/env node
/**
 * Creates the first administrator from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
 *
 *   npm run seed:admin
 *
 * Remove both values from .env once it has run - they are only needed to
 * bootstrap, and there is deliberately no default account.
 */
import { env } from '../src/config/env.js';
import { migrate, closePool } from '../src/db/index.js';
import { createUser, findByEmail, countUsers } from '../src/db/repositories/users.js';

if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
  console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env, then run this again.');
  process.exit(1);
}

if (env.SEED_ADMIN_PASSWORD.length < 12) {
  console.error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

try {
  await migrate({ log: () => {} });

  // Awaited deliberately: every repository call returns a promise now, and an
  // un-awaited one here reads as "the account already exists" whatever the
  // database actually contains - a promise is always truthy.
  if (await findByEmail(env.SEED_ADMIN_EMAIL)) {
    console.log(`${env.SEED_ADMIN_EMAIL} already exists - nothing to do.`);
  } else {
    const user = await createUser({
      email: env.SEED_ADMIN_EMAIL,
      name: 'Administrator',
      password: env.SEED_ADMIN_PASSWORD,
      role: 'admin',
    });

    console.log(`Created administrator ${user.email} (id ${user.id}).`);
    console.log(`Total users: ${await countUsers()}`);
    console.log('\nNow remove SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from .env.');
  }
} finally {
  // Without this the pool keeps the event loop alive and the script hangs.
  await closePool();
}
