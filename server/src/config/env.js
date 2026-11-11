import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveProvider, providerFromHost } from './providers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = path.join(serverRoot, '.env');

// Node's built-in loader, so we don't pull in dotenv. Real environment
// variables already set by the host always win over the file.
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const required = (label) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} must not be empty`);

const secret = (label, minLength = 32) =>
  required(label).min(minLength, `${label} must be at least ${minLength} characters - generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);

const bool = (fallback) =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const port = (fallback) => z.coerce.number().int().positive().max(65535).default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port(4000),
    APP_BASE_URL: required('APP_BASE_URL').url(),
    // How many reverse proxies sit in front of this process.
    //
    // Express counts hops from the right of X-Forwarded-For to decide which
    // entry is the real client. Set it too low and req.ip becomes the nearest
    // proxy's address: every unsubscribe records the wrong IP - which is the
    // evidence of who opted out - and the per-IP rate limits collapse into
    // one global bucket, so a busy campaign can throttle genuine unsubscribes.
    // Set it too high and a forged header lets a direct caller spoof an IP.
    //
    // Netlify -> Caddy -> here is 2. A single proxy is 1.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
    WEB_ORIGIN: required('WEB_ORIGIN').url(),

    TOKEN_HMAC_SECRET: secret('TOKEN_HMAC_SECRET'),
    SESSION_SECRET: secret('SESSION_SECRET'),

    SENDING_DOMAIN: required('SENDING_DOMAIN'),
    MAIL_FROM_NAME: required('MAIL_FROM_NAME'),
    MAIL_FROM_ADDRESS: required('MAIL_FROM_ADDRESS').email(),
    MAIL_REPLY_TO: z.string().trim().email().optional().or(z.literal('')),
    DKIM_SELECTOR: z.string().trim().default('zoho'),
    COMPANY_POSTAL_ADDRESS: required('COMPANY_POSTAL_ADDRESS'),

    // Selects a preset (hosts, SPF include, DKIM selector, sending ceiling).
    // Left unset, it is inferred from SMTP_HOST.
    MAIL_PROVIDER: z.enum(['google', 'zoho', 'other']).optional(),
    SMTP_HOST: required('SMTP_HOST'),
    SMTP_PORT: port(465),
    SMTP_USER: required('SMTP_USER'),
    SMTP_PASSWORD: required('SMTP_PASSWORD'),

    IMAP_ENABLED: bool('true'),
    IMAP_HOST: z.string().trim().default('imap.zoho.com'),
    IMAP_PORT: port(993),
    IMAP_USER: z.string().trim().optional(),
    IMAP_PASSWORD: z.string().optional(),
    IMAP_POLL_SECONDS: z.coerce.number().int().min(30).default(120),

    TRACKING_DOMAIN: z.string().trim().optional().or(z.literal('')),

    // Supabase Postgres. Use the CONNECTION POOLER host, not db.<ref>.supabase.co:
    // the direct host is IPv6-only and will simply time out on an IPv4 network.
    DATABASE_URL: required('DATABASE_URL')
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgres:// connection string',
      }),
    // Tests point this at their own schema so they cannot truncate real
    // tables while sharing a project with production.
    DATABASE_SCHEMA: z.string().trim().regex(/^[a-z_][a-z0-9_]*$/i, 'Schema must be a bare identifier').default('public'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // Optional PEM for verifying Supabase's certificate. Without it the
    // connection is encrypted but the certificate is not checked.
    DATABASE_CA: z.string().optional(),

    SEED_ADMIN_EMAIL: z.string().trim().email().optional().or(z.literal('')),
    SEED_ADMIN_PASSWORD: z.string().optional(),

    // --- Name intelligence (optional) --------------------------------------
    // Used by the Mail Predictor for two narrow language jobs: deciding which
    // word in a name is the surname, and suggesting the short forms a mailbox
    // might use. It never sees a domain and never produces an address.
    //
    // Leave LLM_API_KEY unset and the predictor runs on rules alone - the
    // feature degrades, nothing breaks.
    LLM_API_KEY: z.string().trim().optional().or(z.literal('')),
    LLM_BASE_URL: z.string().trim().url().default('https://api.deepseek.com'),
    LLM_MODEL: z.string().trim().default('deepseek-flash'),
    // DeepSeek defaults to 'high', which on a task this small is slow enough
    // to hit the timeout. Splitting a name needs no deliberation. Blank it
    // for a provider that rejects the field.
    LLM_EFFORT: z.enum(['low', 'high', 'max', '']).default('low'),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(60000),
    // Names per request. Measured: this model spends ~500 reasoning tokens
    // per name, so a very large batch is slow and risks hitting the output
    // ceiling, while one-per-call wastes the round trip. Ten is the balance.
    LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    // Batches in flight at once.
    //
    // Measured on deepseek-flash, not assumed: two concurrent batches of
    // five took 34.8s, the same two run one after the other took 23.0s.
    // The endpoint serialises the work anyway, so asking for parallelism
    // only adds overhead - and the extra pressure made one batch exhaust
    // its output budget. Throughput is about 2.5s per name either way.
    // Raise this only if a measurement on your own key disagrees.
    LLM_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
  })
  // IMAP drives both bounce suppression and sequence reply-exit. If it is on,
  // it must be fully configured or those two features fail silently.
  .refine((env) => !env.IMAP_ENABLED || (env.IMAP_USER && env.IMAP_PASSWORD), {
    message: 'IMAP_USER and IMAP_PASSWORD are required when IMAP_ENABLED is true (bounce handling and reply detection depend on them)',
    path: ['IMAP_USER'],
  })
  // A tracking domain outside the sending domain carries another sender's
  // reputation and is widely blocklisted.
  .refine((env) => !env.TRACKING_DOMAIN || env.TRACKING_DOMAIN.endsWith(env.SENDING_DOMAIN), {
    message: 'TRACKING_DOMAIN must be a subdomain of SENDING_DOMAIN',
    path: ['TRACKING_DOMAIN'],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example for the full list.\n`);
  process.exit(1);
}

const raw = parsed.data;

const provider = resolveProvider(
  raw.MAIL_PROVIDER ?? providerFromHost(raw.SMTP_HOST),
  raw.SMTP_HOST,
);

export const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  replyTo: raw.MAIL_REPLY_TO || raw.MAIL_FROM_ADDRESS,
  // A CHANGE-ME placeholder is present but not *set*. Treating it as set
  // would let the linter pass and ship "CHANGE-ME: your registered postal
  // address" in the footer of every message.
  postalAddressSet: !/CHANGE[_-]?ME/i.test(raw.COMPANY_POSTAL_ADDRESS),
  trackingEnabled: Boolean(raw.TRACKING_DOMAIN),
  // Presence of a key is the whole feature flag. Nothing else needs setting.
  llmEnabled: Boolean(raw.LLM_API_KEY),
  // Implicit TLS on 465; STARTTLS is upgraded and required on anything else.
  smtpSecure: raw.SMTP_PORT === 465,
  // The active preset. Deriving it once here keeps the DNS checker, the
  // preflight and the setup script from drifting apart on which SPF include
  // and DKIM selector they expect.
  provider,

});

export default env;
