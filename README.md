# Mail Service v2

Bulk sales email over your own SMTP provider, built so messages reach the inbox
and every one of them carries a working unsubscribe.

Set `MAIL_PROVIDER` to `google`, `zoho` or `other`. The preset supplies the host
pair, the SPF include the checker verifies, the DKIM selector and the sending
ceiling; nothing above the transport changes between them.

- Node + Express API, Supabase Postgres (`pg`), no Redis
- React (Vite) UI
- Target volume ~2,000/day

## Guides

| | |
|---|---|
| [DEPLOY.md](DEPLOY.md) | Docker image, Render, Netlify, environment variables |
| [DNS-AND-PROVIDERS.md](DNS-AND-PROVIDERS.md) | SPF/DKIM/DMARC, GoDaddy, switching between Google and Zoho |

---

## Read this before you send anything

Both supported providers say the same thing: a normal mailbox is for
person-to-person mail, not bulk.

- **Google** directs bulk senders to a dedicated service and allows roughly
  **2,000 messages per rolling 24 hours** on Workspace (about 500 on a free
  gmail.com account). Exceeding it suspends sending for about a day.
- **Zoho** states Zoho Mail is for one-to-one business communication and points
  bulk senders at Zoho Campaigns or ZeptoMail. It publishes no fixed cap — an
  algorithm sets it from account usage and reputation, so it can tighten
  without warning.

Using a mailbox provider anyway is a reasonable call at low volume. The service
treats those ceilings as a design constraint rather than an afterthought:
conservative caps, a warm-up ramp, per-domain pacing and strict list hygiene are
on by default. The daily cap cannot be set above the provider's ceiling, and
**if the provider rejects a send with a quota error the worker pauses every
campaign** rather than pushing until the account is locked.

The transport sits behind one module
([transport.js](server/src/mail/transport.js)), so moving to a dedicated bulk
provider later is a config change rather than a rewrite.

### Mailboxes

Sending accounts live in the database, not in `.env`, and are managed under
**Settings › Mailboxes**. You can add several — a mix of Zoho and Google is the
expected case — and each campaign picks one when it is created. Picking the
provider fills in the hosts, ports and DKIM selector from a preset, so a mailbox
is an address and an app password.

Each mailbox paces itself: its own daily and hourly caps, its own warm-up ramp
and its own send counters, defaulted from its provider (Zoho ~300/day, Google
~1,200). One hitting its ceiling, or being parked by a provider quota error,
does not stop the others.

Three things stay global on purpose. The sending window and weekend rule are one
schedule for the whole service. The bounce/complaint circuit breaker is a
property of the domain's reputation rather than of any one account. And the
per-receiving-domain burst cap has to be measured across every mailbox, because
Gmail attributes traffic from all of them on one sending domain to a single
sender — three mailboxes each measuring their own allowance would quietly
deliver three times the intended burst.

Passwords are encrypted at rest with AES-256-GCM under `SECRETS_KEY`, and the
API never returns one. **Back that key up with the database**: lose it and every
stored mailbox password has to be re-entered.

The `SMTP_*` and `IMAP_*` variables in `.env` are only a seed for the first
mailbox on an existing install. After that they are ignored.

### Gmail rewrites the From address

Google replaces any `From` that is not the authenticated mailbox or a verified
"Send mail as" alias — which breaks your branding and DKIM alignment at once. So
a Google mailbox's From address and SMTP username must match; saving one that
does not is refused, and so is starting a campaign that overrides the sender on
such a mailbox.

---

## Setup

```bash
npm run install:all
```

Then configure it. This asks six questions and derives the rest:

```bash
npm run setup --prefix server
```

The app password is read with the terminal echo off and written straight to
`.env` — it is never echoed, never shown back as a default, and never placed on
a command line where the shell would log it to history. Use a **Zoho
application-specific password** (Zoho Account → Security → App Passwords), not
your login password.

To see what is still outstanding without changing anything:

```bash
npm run setup --prefix server -- --list
```

It exits non-zero while anything is unset, so it can gate a deploy. The server
also validates every variable at boot and refuses to start if one is missing —
there are no fallback defaults for secrets.

<details>
<summary>Configuring by hand instead</summary>

Copy `server/.env.example` to `server/.env`, generate the two secrets with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, and
fill in the rest. Two pairs must stay consistent, which is the reason the script
exists: `SMTP_HOST` and `IMAP_HOST` have to name the same Zoho data centre, and
that data centre has to match the SPF include on your domain.
</details>

Create the first administrator:

```bash
npm run seed:admin --prefix server
```

Then remove `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from `.env`.

```bash
npm run dev
```

API on `:4000`, UI on `:5173`. Both reload on save — the UI through Vite, the
API through `node --watch`, which is scoped to `server/src` and `.env` so
nothing else can trigger a restart loop.

> If you start the API with `npm start` instead, it does **not** reload. Editing
> a route and seeing `{"error":"Not found"}` almost always means the process is
> still running the code from before the edit.

---

## DNS — do this first

Application-level tuning cannot compensate for unauthenticated mail.

**Start here.** This reads your domain's live DNS and prints the exact records to
publish, computed from what is actually there:

```bash
npm run dns:plan --prefix server -- --domain yourdomain.com --dc in
```

It changes nothing. Pass `--dc` to match your Zoho data centre (`in`, `com`,
`eu`, `com.au`) — the same one as `SMTP_HOST`.

| Record | What it needs |
|---|---|
| **SPF** | Zoho authorised somewhere in the chain. Exactly one SPF record per name; two is a permanent error and both fail. Stay under 10 DNS lookups across the whole include chain, or SPF permerrors even though the record reads fine. |
| **DKIM** | Enable in the Zoho admin console (Email Authentication → DKIM), publish the TXT record it generates, and make `DKIM_SELECTOR` match. |
| **DMARC** | **Exactly one** record at `_dmarc.yourdomain.com`. Start `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`, then tighten to `quarantine` and `reject`. |

### If the domain already sends through Google, Microsoft or another provider

This is the common case and the easy one to get wrong. **Add the Zoho include to
the existing SPF record — do not replace it.** Replacing it breaks every other
sender on the domain, including normal company email.

```
v=spf1 include:<existing> include:zoho.in ~all
```

Providers are often nested one level down behind an SPF-management include, so a
record that does not literally mention Google may still be authorising it. The
checker walks the whole chain rather than string-matching the root record, and
`dns:plan` builds the merged record for you from the real one.

DKIM is not a conflict: each provider uses its own selector, so `google._domainkey`
and `zoho._domainkey` coexist. DMARC is a single shared record covering all of them.

Verify once the records are live:

```bash
npm run check:dns --prefix server
```

This also catches the region trap: an SPF include for the wrong Zoho data
centre (`include:zoho.com` while sending via `smtp.zoho.in`) reads as a correct
record and fails every single message. The check compares the include against
`SMTP_HOST` rather than accepting any Zoho include.

## Preflight

Checks everything that can be checked before credentials exist — that the Zoho
hosts resolve, the ports are open, TLS negotiates and the certificates are
valid. No credentials are sent.

```bash
npm run preflight --prefix server
```

Run it first, so that when you do add the app password an authentication
failure means the password and not the network.

The sender worker **refuses to send while SPF or DKIM is failing**. That guard is
on by default and can be turned off in Settings, but doing so defeats the purpose
of the service.

Confirm the SMTP path, and send yourself a real message built by the real composer:

```bash
node server/scripts/smtp-test.js --to you@yourdomain.com
```

---

## What the sales team gets

1. **Sign in** — each rep has their own account. Contacts and lists are shared;
   campaigns are attributed to whoever sent them.
2. **Import a CSV** — returns a validation report rather than silently accepting
   everything: valid rows accepted, shared mailboxes (`info@`, `sales@`) flagged,
   and malformed / dead-domain / disposable / duplicate / already-unsubscribed rows
   rejected with a reason. List quality is visible *before* anything is mailed.
3. **Compose** with merge fields — `{{first_name}}`, `{{company}}`, `{{email}}`,
   plus any extra CSV column.
4. **Live content score** — flags shorteners, shouted subjects, trigger phrasing
   and poor text-to-image ratio while they type. Hard-blocks a missing unsubscribe
   link or postal address.
5. **Preview and test** — desktop, mobile and plaintext views, plus a real test
   send to themselves.
6. **Tracking toggle** — per campaign, **off by default**.
7. **Sequences** — optional follow-up steps with a wait in days. Anyone who
   replies, unsubscribes or bounces is removed automatically. Follow-ups thread
   onto the original message.
8. **Send or schedule** — pacing is automatic; reps configure nothing.
9. **Watch it run** — live progress, per-recipient status, bounces.
10. **Dashboard** — domain health, quota, warm-up stage, bounce and complaint rates.

Replies land in the normal Zoho inbox and are answered there. The app detects
*that* a reply arrived (to stop the sequence); it is not an inbox.

**Not included:** unified reply inbox, CRM sync, A/B testing, per-rep data
separation.

---

## How inbox placement is protected

**Message construction** ([compose.js](server/src/mail/compose.js))
- Always `multipart/alternative` with a genuine plain-text part generated from the
  HTML. HTML-only mail is a strong spam signal.
- RFC 8058 one-click unsubscribe on every message:
  `List-Unsubscribe` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
  This is what makes Gmail and Yahoo render their own Unsubscribe control.
- Footer with the unsubscribe link and postal address is **injected server-side**,
  so a campaign without an opt-out is not possible.
- Body sanitised with `sanitize-html` on write *and* on send.

**Pacing** ([sender.js](server/src/workers/sender.js)) — all configurable, none
bypassable by a campaign:
- Daily cap and warm-up ramp (starts ~20/day, builds over weeks)
- Randomised jitter between sends, not a fixed interval
- Per-receiving-domain hourly cap
- Business-hours window, weekends off by default
- One pooled SMTP connection, reused

**List hygiene** ([email-validation.js](server/src/lib/email-validation.js))
- MX lookup per domain at import; no MX means rejected, not discovered as a bounce
- Role-account and disposable-domain detection, de-duplication
- Suppression re-checked **inside the job-claim transaction**, so an unsubscribe
  arriving mid-campaign is honoured for the rest of the run

**Auto-pause** — sending stops across all campaigns if the 24-hour bounce rate or
complaint rate crosses the threshold (default 5% / 0.3%), or if Zoho returns a
quota error.

**Unsubscribe** ([unsubscribe.js](server/src/routes/unsubscribe.js))
- HMAC-SHA256 signed tokens, constant-time verification, no enumerable IDs
- **`GET` renders a confirmation page and changes nothing; `POST` performs the
  opt-out.** Security gateways follow every URL in an email, so a GET-based
  unsubscribe would quietly remove people who never clicked. One-click clients
  POST, so Gmail's native button still works instantly.
- Permanent and global, with a full audit record

**Tracking** ([tracking.js](server/src/mail/tracking.js)) — only when opted in
- Runs on a subdomain of the sending domain (enforced at boot)
- Redirect destination is signed **inside** the token, never a query parameter —
  an unsigned redirect param is an open redirect, and an open redirect on a
  sending domain gets it blocklisted
- The unsubscribe link is never rewritten
- Scanner and prefetch traffic is flagged and excluded from headline numbers

A note on open rates: Apple Mail Privacy Protection and corporate scanners inflate
opens badly. **Clicks and replies are the signals worth acting on.**

---

## Testing

```bash
npm test --prefix server
```

Covers message construction, the one-click headers, token tampering and type
confusion, the linter's blocking rules, and every sequence exit guarantee
(reply / unsubscribe / bounce / pause).

End-to-end checks worth doing manually once the domain is live:

- Send to seed addresses on Gmail, Outlook and Yahoo. For each: did it land in the
  inbox? Does *Show original* report `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`?
  Does Gmail show its own **Unsubscribe** link beside the sender? That link
  appearing is the practical proof the RFC 8058 headers are right.
- Click the footer link → confirmation page appears and the contact is *not* yet
  suppressed. Confirm → they are.
- Reply to step 1 of a sequence → confirm step 2 never arrives.

---

## Operational notes

- **The database holds contact PII.** It lives in Supabase Postgres, which
  encrypts at rest; the connection uses TLS. `DATABASE_URL` carries the
  password, so it belongs in an environment variable and never in the repo —
  `.gitignore` and `.dockerignore` both exclude every `.env*` except the
  `.example` templates.
- **IMAP must be on** for bounce suppression and reply detection. With it off,
  dead addresses are never suppressed and sequences do not stop on reply — the
  dashboard warns about this.
- Reps share one pool of contacts and lists. Accounts give attribution and
  revocable access, not data separation. A `tenant_id` column is present on the
  main tables for scoping later.
- Deactivating a user ends their session on their next request.

## Layout

```
server/
  src/
    config/env.js        zod-validated environment, fails fast
    db/                  schema, migrations, repositories (all SQL lives here)
    mail/                transport, compose, tokens, tracking, spam-lint
    workers/             sender, sequencer, inbox-poller
    routes/              auth, contacts, campaigns, unsubscribe, tracking, health
  scripts/               check-dns, smtp-test, migrate, seed-admin
web/                     React UI
```
