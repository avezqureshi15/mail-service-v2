# Deploying mail-service-v2

Frontend on Netlify, backend as a Docker image on Render, database on Supabase.

The two halves are served from **one origin**: Netlify proxies `/api`, `/u`
and `/t` through to Render. That is not decoration — see
[Why the proxy](#why-the-proxy) before changing it.

---

## Order of operations

There is a circular dependency: Netlify needs the Render URL, and Render needs
the Netlify URL. Break it by deploying Render first with a placeholder, then
coming back.

1. Push the image to Docker Hub
2. Create the Render service → note its URL
3. Put the Render URL in `web/netlify.toml` → deploy Netlify → note its URL
4. Set `APP_BASE_URL` and `WEB_ORIGIN` on Render to the Netlify URL → redeploy

Step 4 is an environment-variable change only, so it is quick.

---

## 1. The image

```bash
docker build --platform linux/amd64 -t avezqureshi15/mail-service-v2:latest ./server
```

```bash
docker push avezqureshi15/mail-service-v2:latest
```

`--platform linux/amd64` matters: Render runs amd64, and an image built on an
Apple Silicon machine without it will not start there.

The image contains **no secrets**. `.dockerignore` excludes `.env`, and every
credential is supplied by Render at run time.

---

## 2. Render

### Create the service

1. Render dashboard → **New +** → **Web Service**.
2. Under *Source Code*, choose **Existing Image** (not a Git repository).
3. **Image URL**: `docker.io/avezqureshi15/mail-service-v2:latest` → **Connect**.
   The image is public, so no registry credentials are needed. The
   `docker.io/` prefix is optional; Render defaults the host to Docker Hub.
4. **Name**: anything — it becomes the `onrender.com` hostname.
5. **Region**: **Singapore**. Of Render's five regions (Oregon, Ohio,
   Virginia, Frankfurt, Singapore) it is nearest to the Supabase project in
   Seoul. Every query is now a network round trip, so this is the difference
   between ~50 ms and ~250 ms on *each one* — and a dashboard load makes
   several.
6. **Instance type**: Free.
7. **Health check path**: `/api/healthz`. Unauthenticated and touches no
   database, so it answers while the pool is still warming.
8. Leave the Docker command blank — the image already has the right entrypoint.
9. Add the environment variables below, then **Create Web Service**.

The image is linux/amd64 and 297 MB, within Render's 10 GB limit.

### Environment variables

**Do not set `PORT`.** Render injects it (default `10000`) and the app reads
it. Setting it yourself to 4000 means Render routes to a port nothing is
listening on. `NODE_ENV` is already `production` inside the image.

**Do not set `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.** The admin account
already exists in Supabase; those are local bootstrap values.

**Required — the service will not boot without these:**

| Variable | Value |
|---|---|
| `APP_BASE_URL` | the Netlify URL (step 4; use the Render URL as a placeholder for now) |
| `WEB_ORIGIN` | the Netlify URL (same) |
| `TOKEN_HMAC_SECRET` | from `server/.env` — rotating it kills every live unsubscribe link |
| `SESSION_SECRET` | from `server/.env` — rotating it signs everyone out |
| `SECRETS_KEY` | from `server/.env` — **back this up with the database.** It encrypts every stored mailbox password; lose it or change it and all of them have to be re-entered |
| `DATABASE_URL` | the Supabase **session pooler** string, port 5432 |
| `SENDING_DOMAIN` | `webknot.in` |
| `MAIL_FROM_NAME` | from `server/.env` |
| `MAIL_FROM_ADDRESS` | from `server/.env` |
| `COMPANY_POSTAL_ADDRESS` | from `server/.env` — legally required in every commercial email |
| `SMTP_HOST` | `smtp.gmail.com` — only used to seed the first mailbox |
| `SMTP_USER` | from `server/.env` — same |
| `SMTP_PASSWORD` | the Gmail app password — same |

### Mailboxes are configured in the app, not here

SMTP and IMAP credentials live in the `mailboxes` table and are managed under
**Settings › Mailboxes**. Each mailbox carries its own provider, hosts, app
password, DKIM selector, daily cap and warm-up ramp, and a campaign picks one
when it is created.

The `SMTP_*`, `IMAP_*` and `DKIM_SELECTOR` variables are a **seed source only**.
On first boot against a database with no mailboxes, the service creates one from
them and attributes existing campaigns, jobs, counters and the IMAP read position
to it — so an upgrade keeps sending without interruption. After that they are
ignored; editing them changes nothing.

Passwords are encrypted with AES-256-GCM under `SECRETS_KEY` before they are
stored, and the API never returns one. A blank password field in the UI means
"leave the stored one alone".

**Adding a second mailbox:** Settings › Mailboxes › Add a mailbox. Pick the
provider and the hosts, ports and DKIM selector fill themselves in. Use
**Test connection** before sending anything — it checks SMTP login, IMAP login
and the SPF/DKIM/DMARC records for that mailbox's own domain and selector.

**Also set:**

```
MAIL_REPLY_TO        IMAP_ENABLED=true     IMAP_PORT=993
IMAP_USER            IMAP_PASSWORD         IMAP_POLL_SECONDS=120
SMTP_PORT=465        DATABASE_SCHEMA=public    DATABASE_POOL_MAX=10
```

`TRACKING_DOMAIN` and `DATABASE_CA` can be left unset.

### Pushing a new image later

Render does **not** redeploy automatically when a new image is pushed to the
same tag. After any `docker push`, go to **Manual Deploy → Deploy latest
reference**, or call the service's deploy hook (Settings → Deploy Hook).

This is why the image also carries a dated tag. `latest` moving under you is
exactly the situation where you want to know which build is actually running.

## 3. Netlify

`netlify.toml` lives at the **repository root** (not in `web/`) — that is
where Netlify looks for it. It sets `base = "web"`, so the build runs there
and `publish` / the functions directory resolve relative to it.

The Render URL is already filled into all three proxy redirects.

### This project has no version control

There is no git repository here. That blocks the usual Netlify flow, and it
is worth fixing for its own sake — an editor file was corrupted earlier in
this project and there was no history to recover from.

**Option A — git + GitHub (recommended).** Solves two problems at once: real
version control, and Netlify redeploys on every push.

```bash
git init && git add -A && git commit -m "mail-service-v2"
```

Create an empty repo on GitHub, push to it, then in Netlify choose
**Add new site → Import an existing project** and pick it. Netlify reads
`netlify.toml` and needs no further configuration.

Check `git status` before the first commit: `.gitignore` already excludes
`.env`, `.env.*` (except the two examples) and `*.db`, but confirm no
credential is staged.

**Option B — Netlify CLI (faster, no git).**

```bash
npx netlify-cli login
```

```bash
npx netlify-cli deploy --prod
```

Run it from the repository root so it finds `netlify.toml`. The CLI applies
the redirects, headers and the scheduled function, same as a git deploy. You
just have to run it by hand for every change.

> Do **not** drag `web/dist` into the Netlify UI. That uploads the built
> files and nothing else: no proxy redirects, so every API call 404s; no SPA
> fallback, so refreshing a page 404s; and no keep-alive function, so Render
> sleeps. The app would appear to deploy and then not work.

## Why the proxy

The app authenticates with a session cookie, issued as
`Secure; HttpOnly; SameSite=Lax`. Verified against the built image:

| Request | Cookie issued | `/api/dashboard` |
|---|---|---|
| plain HTTP, `NODE_ENV=production` | no | 401 |
| behind a TLS-terminating proxy | yes | 200 |

`SameSite=Lax` means the browser will not send that cookie on a **cross-site**
request. A React app on `netlify.app` calling `onrender.com` directly is
cross-site, so login would appear to succeed and every subsequent call would
return 401.

Working around that needs `SameSite=None`, which weakens CSRF protection and
is a third-party cookie — blocked outright by Safari and being phased out in
Chrome. Proxying through Netlify keeps everything first-party, needs no CORS
configuration at all, and puts unsubscribe links on your own domain.

---

## The keep-alive

`web/netlify/functions/keep-alive.mjs` runs on Netlify's scheduler every 10
minutes and requests `/api/healthz`.

It lives on Netlify rather than inside the backend for a specific reason: a
timer inside the app only runs while the app is awake. It could keep the
service alive but could never bring it back, because once the service sleeps
the timer is asleep with it. The wake-up call has to come from outside the
thing being woken.

It pings **its own site URL**, which `netlify.toml` proxies through to Render.
So there is no backend URL to configure in the function, and nothing to update
when the Render URL changes.

Verified against the built image before deployment:

| Case | Result |
|---|---|
| backend reachable | 200 `ok` |
| backend down | 502, logged with the reason |
| site URL missing | 500, logged |

The logs distinguish a warm reply from a cold start: anything over 5 seconds
is reported as `(slow - the instance had spun down)`, which means the pinger
found the service asleep and something let it idle out.

Scheduled functions only run on sites built by Netlify. If you deploy by
dragging `dist` into the UI, the function is never registered and the service
will sleep — another reason to connect the repository.

---

## After the first deploy

- Sign in and confirm the dashboard loads.
- Open an unsubscribe link from a real test send; confirm it resolves to the
  Netlify domain and completes.
- Check Render's logs for `[sender] worker started`, `[sequencer] worker
  started` and the first `[inbox] examined N` line.
- Check the Netlify function log after ~10 minutes for `keep-alive: ok`, and
  watch Render's metrics over the first day to confirm it never spins down.

## Still outstanding

- **DMARC**: `_dmarc.webknot.in` has two TXT records, so receivers treat the
  domain as having none. Replace both with a single record:
  `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com,mailto:pranav.ks@webknot.in`
- Rotate the Supabase database password and the Gmail app password — both have
  appeared in a chat transcript.
- Remove `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `server/.env` once you
  have signed in.
