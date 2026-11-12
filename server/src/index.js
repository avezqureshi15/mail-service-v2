import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

import { env } from './config/env.js';
import { pool, migrate, closePool } from './db/index.js';
import { loadSettings } from './db/repositories/settings.js';
import { loadMailboxes, allMailboxes } from './db/repositories/mailboxes.js';
import { ensureDefaultMailbox } from './db/seed-mailbox.js';
import {
  loadUser, apiLimiter, globalLimiter, notFound, errorHandler,
} from './middleware/index.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { contactsRouter, listsRouter, suppressionsRouter } from './routes/contacts.js';
import { campaignsRouter } from './routes/campaigns.js';
import { mailboxesRouter } from './routes/mailboxes.js';
import { healthRouter, settingsRouter } from './routes/health.js';
import { unsubscribeRouter } from './routes/unsubscribe.js';
import { trackingRouter } from './routes/tracking.js';
import { templatesRouter } from './routes/templates.js';
import { predictorRouter } from './routes/predictor.js';
import { startSender, stopSender, drainSender } from './workers/sender.js';
import { closeAllTransports } from './mail/transport.js';
import { startSequencer, stopSequencer } from './workers/sequencer.js';
import { startInboxPoller, stopInboxPoller } from './workers/inbox-poller.js';
import { startDeliveryConfirmer, stopDeliveryConfirmer } from './workers/delivery-confirmer.js';
import { countUsers } from './db/repositories/users.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = express();

// Behind a reverse proxy in production, so req.ip and secure cookies work.
app.set('trust proxy', env.isProduction ? env.TRUST_PROXY_HOPS : false);
app.disable('x-powered-by');

app.use(helmet({
  // The unsubscribe page is server-rendered with a small inline stylesheet.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: env.WEB_ORIGIN,
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
// RFC 8058 one-click unsubscribe posts application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Mounted ahead of the session middleware on purpose: loadUser does a
// database read for every request carrying a session cookie, so a flood of
// forged cookies would otherwise reach Postgres before anything turned it
// away. Rate limiting is cheapest when it happens first.
app.use(globalLimiter);

const PgStore = connectPgSimple(session);

app.use(session({
  // Sessions share the application pool and live in the application schema,
  // so a test run pointed at another schema gets its own session table and
  // cannot sign anyone out of the real one.
  store: new PgStore({
    pool,
    schemaName: env.DATABASE_SCHEMA,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  name: 'msid',
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    // Requires HTTPS in production; left off locally so dev over http works.
    secure: env.isProduction,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  },
}));

app.use(loadUser);

// --- Public routes (no auth, by necessity) ---------------------------------
// Unsubscribe must work for someone who has never signed in, and tracking
// endpoints are hit by mail clients.
app.use('/', unsubscribeRouter);
app.use('/', trackingRouter);

// --- API -------------------------------------------------------------------
app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/lists', listsRouter);
app.use('/api/suppressions', suppressionsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/mailboxes', mailboxesRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/predictor', predictorRouter);
app.use('/api/settings', settingsRouter);
app.use('/api', healthRouter);

// --- Built frontend, when present ------------------------------------------
const webDist = path.join(serverRoot, '..', 'web', 'dist');
app.use(express.static(webDist, { index: false }));
app.get(/^\/(?!api|u\/|t\/).*/, (req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use(notFound);
app.use(errorHandler);

/**
 * Nothing may serve a request or claim a send job until the schema is in
 * place and the settings cache is warm.
 *
 * The workers read settings synchronously on every tick, and the pacing
 * caps are what stop the account being run into a sending suspension. A
 * worker started before the first load would spend that window using the
 * built-in defaults rather than the configured ones, so both finish here
 * before anything starts.
 */
let server;

async function start() {
  const applied = await migrate({ log: () => {} });
  if (applied > 0) console.log(`database: applied ${applied} migration(s)`);

  // Before anything reads a mailbox and before any worker starts: migration
  // 007 leaves every mailbox_id nullable so this can turn the .env mailbox
  // into a row and attribute existing campaigns, jobs, counters and the IMAP
  // read position to it. A deployment that was sending keeps sending.
  await ensureDefaultMailbox();

  await Promise.all([loadSettings(), loadMailboxes()]);

  server = app.listen(env.PORT, async () => {
    console.log(`\nmail-service-v2 listening on http://localhost:${env.PORT}`);
    console.log(`  database       : ${describeDatabase()}`);
    console.log(`  tracking       : ${env.trackingEnabled ? env.TRACKING_DOMAIN : 'disabled'}`);
    describeMailboxes();

    if (await countUsers() === 0) {
      console.log('\n  No users yet. Create the first administrator with: npm run seed:admin\n');
    }

    startSender();
    startSequencer();
    startInboxPoller();
    startDeliveryConfirmer();
  });
}

/**
 * One line per sending mailbox. Replaces the single SMTP line that used to
 * print env.SMTP_HOST, which is now only a seed source.
 */
function describeMailboxes() {
  const mailboxes = allMailboxes();

  if (mailboxes.length === 0) {
    console.log('  mailboxes      : none - add one in Settings > Mailboxes before sending');
    return;
  }

  console.log(`  mailboxes      : ${mailboxes.length}`);
  for (const mailbox of mailboxes) {
    const flags = [
      mailbox.is_default ? 'default' : null,
      mailbox.is_active ? null : 'inactive',
      mailbox.imap_enabled ? null : 'no IMAP',
    ].filter(Boolean);
    const suffix = flags.length ? `  [${flags.join(', ')}]` : '';
    console.log(`    - ${mailbox.label} <${mailbox.from_email}> via ${mailbox.smtp_host}${suffix}`);
  }
}

/** Host and schema only - never the connection string, which has the password. */
function describeDatabase() {
  try {
    return `${new URL(env.DATABASE_URL).host} schema=${env.DATABASE_SCHEMA}`;
  } catch {
    return `schema=${env.DATABASE_SCHEMA}`;
  }
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  stopSender();
  stopSequencer();
  stopInboxPoller();
  stopDeliveryConfirmer();

  // Order matters. A loop mid-claim holds a pooled database connection, so
  // closing the pool before it finishes turns a clean shutdown into a burst
  // of connection errors - and exiting mid-sendMail can leave a job marked
  // 'sending' that the stale-lock sweep later requeues, sending it twice.
  await drainSender();

  // Mandatory, not tidy: a pooled SMTP connection with a live socket keeps
  // the event loop alive, which turns a clean exit into a hang. This was
  // never called at all while there was one global pool.
  await closeAllTransports().catch(() => {});

  // Do not hang forever if a connection refuses to close.
  const giveUp = setTimeout(() => process.exit(0), 15_000);
  giveUp.unref();

  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  // Released last: in-flight handlers still need the pool while the server
  // is draining, and a pool closed underneath them turns a clean shutdown
  // into a burst of connection errors.
  await closePool().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error(`\nFailed to start: ${error.message}\n`);
  process.exit(1);
});

export { app };
