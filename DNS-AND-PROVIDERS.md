# DNS and sending providers

Everything about domain authentication and about switching between Google
Workspace and Zoho Mail.

**Read this before touching DNS or changing `SMTP_HOST`.** The mistakes here
do not announce themselves: the service keeps running, the dashboard looks
normal, and mail quietly stops reaching inboxes.

> **If you are an AI agent working on this repo:** do not infer DNS state
> from this document. The records below were true on 2026-11-10. Run
> `npm run check:dns` and `npm run dns:plan` (both read-only) and work from
> what they return. Never publish a DNS record you have not first computed
> from the live record — the most common catastrophic edit here is replacing
> an SPF record and silently breaking the company's normal email.

---

## 1. Why this matters more than usual

Most applications treat DNS as setup you do once. This one **enforces it at
run time**.

`settings.requireDomainAuth` defaults to `true`. The sender worker re-checks
SPF and DKIM hourly, and if either fails it **pauses every sending campaign**
and writes the reason into `domain_health`. That is deliberate:
unauthenticated bulk mail goes to spam no matter how carefully it is paced,
so sending it is worse than not sending at all.

Practical consequence: a DNS mistake does not produce a DNS error. It
produces "my campaign stopped and I don't know why". The first place to look
is the dashboard's domain authentication panel, then `npm run check:dns`.

---

## 2. The three records, and what each one does

| Record | Answers | Failure mode |
|---|---|---|
| **SPF** | may this server send for this domain? | mail marked spam or rejected |
| **DKIM** | was this message altered in transit? | fails alignment, damages reputation |
| **DMARC** | what should a receiver do when the above fail? | no policy, no reports |

They are independent. SPF passing tells you nothing about DKIM.

### Commands

Both are read-only and change nothing.

```bash
npm run check:dns --prefix server
```

Pass/fail for the domain in `.env`, using `DKIM_SELECTOR`. This is what the
sender worker runs internally.

```bash
node server/scripts/dns-plan.js --domain webknot.in --provider zoho --dc in
```

Reads the **live** record and prints the exact change list — including the
merged SPF record computed from what is actually published. Use this rather
than hand-writing records.

---

## 3. Current state of webknot.in

As of 2026-11-10. Verify before relying on it.

```
MX       1 aspmx.l.google.com, 5 alt1/alt2, 10 alt3/alt4   -> Google Workspace
SPF      v=spf1 include:dc-aa8e722993._spfm.webknot.in ~all
DKIM     google._domainkey.webknot.in   published
DMARC    TWO records  <- a fault, see §6
```

Three things to notice:

**Inbound mail is Google.** The MX records decide where mail *to*
`@webknot.in` is delivered. This matters for bounce handling — see §8.

**The SPF record uses a flattening service.** `dc-aa8e722993._spfm.webknot.in`
is a managed-SPF include (Brevo's SPF manager; there is also a
`brevo-code:` verification TXT on the domain). The real senders are listed
inside that, not in the record itself. `npm run check:dns` resolves the whole
chain and reports `authorises Google Workspace`, 2 of 10 lookups.

So when you add a provider you may have a choice: add the include to the root
record, or add it inside the Brevo SPF manager. `dns-plan` always proposes the
root record, because that is the one it can compute reliably.

**The root TXT record holds much more than SPF** — several
`google-site-verification=` entries, `hosting-site=`, `brevo-code:`. These are
separate TXT records at the same name. Editing SPF means editing *the one
record that starts with `v=spf1`*, leaving the others alone.

---

## 4. SPF

One record per domain, starting `v=spf1`, ending in `~all` (softfail) or
`-all` (hardfail).

### The rule that matters most

**Never replace an SPF record. Add to it.**

A domain has exactly one SPF record covering *every* system that sends for
it. Replacing `v=spf1 include:dc-...._spfm.webknot.in ~all` with
`v=spf1 include:zoho.in ~all` authorises Zoho and de-authorises everything
else — the company's normal Google Workspace mail starts failing SPF
immediately. This is the single most damaging edit available on this page,
and it looks completely reasonable while you are making it.

`dns-plan` exists to stop that. It prints the merged value:

```
Was   : v=spf1 include:dc-aa8e722993._spfm.webknot.in ~all
Value : v=spf1 include:dc-aa8e722993._spfm.webknot.in include:zoho.in ~all
```

### The 10-lookup limit

SPF allows a maximum of **10 DNS lookups** while evaluating. Exceed it and
the result is `permerror`, which most receivers treat as a failure — so
adding one include too many breaks SPF for everything at once.

`include:`, `a`, `mx`, `ptr`, `exists` and `redirect` each cost a lookup.
`ip4:`, `ip6:` and `all` cost nothing.

webknot.in is at **2 of 10**, so there is plenty of headroom. `check:dns` and
`dns-plan` both report the count, and `dns-plan` tells you what the count
would become after the change.

### Provider includes

| Provider | include |
|---|---|
| Google Workspace | `_spf.google.com` |
| Zoho (Global) | `zoho.com` |
| Zoho (India) | `zoho.in` |
| Zoho (Europe) | `zoho.eu` |
| Zoho (Australia) | `zoho.com.au` |

**The Zoho include must match the data centre the account lives in.** An
account in the India DC authorised with `include:zoho.com` produces a record
that reads perfectly and fails every message. `checkSpf` detects this
specific mismatch and reports it rather than just saying "fail".

---

## 5. DKIM

A public key published at `<selector>._domainkey.<domain>`, matching a private
key the provider signs with.

**You cannot pre-write a DKIM record.** The provider generates the key pair
and shows you the value. `dns-plan` says so rather than inventing one.

| Provider | Selector | Where to enable |
|---|---|---|
| Google Workspace | `google` | Admin console → Apps → Google Workspace → Gmail → Authenticate email |
| Zoho Mail | `zoho` | Zoho Mail Admin → Domains → *domain* → Email Configuration → DKIM |

### The selector must match `DKIM_SELECTOR`

`DKIM_SELECTOR` in the environment tells the checker which record to look up.
It defaults to **`zoho`** — a leftover from when this service was built
against Zoho first.

So on Google, `DKIM_SELECTOR=google` is **required**. Omit it and the checker
looks up `zoho._domainkey.webknot.in`, finds nothing, reports DKIM failing,
and the sender **auto-pauses every campaign** — while DKIM is in fact working
perfectly. The symptom is "sending mysteriously stopped"; the cause is one
missing environment variable.

Selectors are independent, so several providers can publish DKIM on the same
domain simultaneously. `google._domainkey` and `zoho._domainkey` coexist
without conflict, which is what makes a gradual migration possible.

---

## 6. DMARC — and the fault currently on this domain

One record at `_dmarc.<domain>`.

**webknot.in currently has two:**

```
v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com
v=DMARC1; p=none; rua=mailto:pranav.ks@webknot.in
```

Per RFC 7489, when a receiver finds more than one DMARC record it **ignores
DMARC for the domain entirely**. The domain is configured twice and protected
zero times. This is worse than having none, because it looks configured.

### The fix

Delete both TXT records at `_dmarc` and publish one:

```
v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com,mailto:pranav.ks@webknot.in
```

Multiple reporting addresses belong in **one record, comma-separated** — which
is what the two separate records were each trying to express.

### Policy progression

`p=none` monitors and reports without affecting delivery. Correct while
starting out. Once the aggregate reports show only legitimate sources passing,
tighten to `p=quarantine`, then `p=reject`. Do not start at `reject` — you
will discover the systems you forgot about by having their mail disappear.

---

## 7. GoDaddy specifics

webknot.in's DNS is at GoDaddy. **Domains → DNS → Manage Zones → webknot.in.**

### Field conventions

**GoDaddy appends the domain for you.** In the Name field enter the host
*relative* to the domain:

| Record | Name field | Not this |
|---|---|---|
| SPF (root) | `@` | `webknot.in` |
| DMARC | `_dmarc` | `_dmarc.webknot.in` |
| DKIM | `google._domainkey` | `google._domainkey.webknot.in` |

Entering the fully-qualified name creates `_dmarc.webknot.in.webknot.in`,
which resolves to nothing. This is the most common GoDaddy mistake and it is
invisible until you query the record.

### Traps

**Several TXT records share the name `@`.** The root has SPF plus various
verification strings. Edit the one beginning `v=spf1` and leave the rest —
deleting a `google-site-verification` breaks an unrelated integration.

**GoDaddy will happily create a duplicate.** It does not warn that two DMARC
records are invalid, which is how this domain ended up with two. Delete
before you add.

**Long DKIM values.** Keys often exceed 255 characters, the per-string TXT
limit. GoDaddy's UI normally handles the splitting; if it rejects the value,
split it into quoted chunks — a TXT record is a *sequence* of strings
concatenated on read.

**TTL and propagation.** Default TTL is 1 hour; changes typically appear in
minutes but can take up to the old TTL. `check:dns` queries 1.1.1.1 and
8.8.8.8 directly, bypassing any local resolver cache — useful, because this
machine's own resolver has returned junk for other lookups before.

---

## 8. Switching from Google to Zoho

The code is provider-agnostic. Everything below the transport — pacing,
warm-up, suppression, bounce handling, unsubscribe — is identical. What
changes is the host pair, the SPF include, the DKIM selector, and the volume
ceiling.

### Before you start: read this

**Both providers forbid what this service does.** Google directs bulk senders
to a dedicated provider; Zoho directs them to Zoho Campaigns or ZeptoMail.
Both figures below are mailbox limits, not bulk-sending allowances. Running
cold outreach at volume through either risks the account that also carries
the company's normal mail. Switching from one to the other does not change
this — if volume is the problem, the answer is a dedicated sending provider
(ZeptoMail, Amazon SES, Postmark), not a different mailbox.

**Zoho's ceiling is lower and less predictable.**

| | Google Workspace | Zoho Mail |
|---|---|---|
| Ceiling | ~2,000/day (documented) | ~500/day (estimated — Zoho publishes none) |
| Recommended cap | 1,200 | 300 |
| Set by | published policy | an algorithm, from usage and reputation |

Zoho's cap can tighten without warning. If 1,200/day is a requirement, Zoho
is a downgrade.

### The step that is easy to miss

**Bounces follow MX, not SMTP.**

A bounce is a message sent back to the envelope sender —
`MAIL_FROM_ADDRESS`, i.e. `avez@webknot.in`. Mail *to* that address is
delivered according to webknot.in's **MX records**, which currently point at
Google.

So if you switch SMTP to Zoho but leave MX at Google:

- `SMTP_HOST=smtp.zoho.in` — outbound via Zoho
- `IMAP_HOST=imap.gmail.com` — bounces still arrive at Google

`npm run preflight` will warn that SMTP and IMAP are different providers. In
this specific case **that warning is expected and the configuration is
correct** — IMAP must point wherever MX points, or the poller watches an empty
mailbox and you silently lose all bounce and reply detection.

If you also move MX to Zoho, move `IMAP_HOST` with it. The rule is: **IMAP
follows MX; SMTP is independent.**

> Not verified here: whether Zoho permits SMTP sending for a domain whose MX
> points elsewhere. Zoho requires domain verification, and some Zoho Mail
> functionality assumes Zoho hosts the domain. Confirm with Zoho before
> planning a split setup.

### Checklist

**1. Zoho side**

- Add and verify webknot.in in Zoho Mail Admin
- Create or confirm the mailbox for `MAIL_FROM_ADDRESS`
- Note the **data centre** — it determines everything below. The sign-in URL
  tells you: `zoho.in` → India, `zoho.com` → Global, `zoho.eu` → Europe
- Enable DKIM, selector `zoho`, and copy the generated TXT value
- Generate an **application-specific password** (Zoho Account → Security →
  App Passwords). Not the account password

**2. DNS** — run the planner first:

```bash
node server/scripts/dns-plan.js --domain webknot.in --provider zoho --dc in
```

Its output for the current state:

```
1. REPLACE TXT  @
   Was   : v=spf1 include:dc-aa8e722993._spfm.webknot.in ~all
   Value : v=spf1 include:dc-aa8e722993._spfm.webknot.in include:zoho.in ~all
   Note  : 3 of 10 DNS lookups after this change

2. ADD TXT      zoho._domainkey
   Value : <the value Zoho generates>

3. REPLACE TXT  _dmarc
   Was   : 2 separate records
   Value : v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com,mailto:pranav.ks@webknot.in
```

Note it keeps the Google include. Both providers stay authorised, so you can
switch back without another DNS change.

**3. Environment** — on Render, and in `server/.env` for local:

```
MAIL_PROVIDER=zoho
SMTP_HOST=smtp.zoho.in         # the .in suffix IS the data centre
SMTP_PORT=465
SMTP_USER=avez@webknot.in
SMTP_PASSWORD=<Zoho app password>
DKIM_SELECTOR=zoho
IMAP_HOST=imap.zoho.in         # ONLY if MX also moved to Zoho (see above)
IMAP_PORT=993
IMAP_USER=avez@webknot.in
IMAP_PASSWORD=<Zoho app password>
```

The region is inferred from `SMTP_HOST` — `resolveProvider()` parses
`smtp.zoho.<region>` and derives the SPF include from it. Set
`SMTP_HOST=smtp.zoho.com` for an India account and the checker will report
the mismatch rather than letting every message fail SPF.

**4. Lower the caps.** Settings → Sending. Daily cap 1,200 → **300**, and
the hourly cap and send interval with it. Leaving Google's figures against a
Zoho account runs it straight into a suspension partway through a campaign.

**5. Verify**

```bash
npm run check:dns --prefix server
```

```bash
npm run preflight --prefix server
```

```bash
npm run check:smtp --prefix server
```

Then send a test to yourself from a campaign and inspect the headers in Gmail
(**Show original**): SPF, DKIM and DMARC should all read `PASS`, and the
signing domain should be `webknot.in`, not a Zoho domain. If `d=` is not your
domain, DKIM is signing but not *aligned*, and DMARC will still fail.

---

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Campaigns auto-paused, "domain authentication failing" | `DKIM_SELECTOR` does not match the published selector. Check `check:dns` |
| DKIM fails right after enabling | Not propagated yet. Wait out the TTL and re-check |
| SPF `permerror` | Over 10 lookups. `check:dns` reports the count |
| SPF passes, DMARC fails | Alignment: the `d=` domain or Return-Path does not match the From domain |
| Normal company email started failing SPF | An SPF record was replaced instead of extended. Restore the previous value and merge |
| No bounces or replies detected | `IMAP_HOST` does not point where MX points |
| `535 Authentication failed` | Account password used instead of an app-specific password |
| Two DMARC records | Delete both, publish one merged record |

### Where the logic lives

| File | Role |
|---|---|
| `server/src/config/providers.js` | presets: hosts, SPF includes, selectors, limits, regions |
| `server/src/lib/dns-check.js` | `checkSpf` / `checkDkim` / `checkDmarc` |
| `server/src/lib/spf.js` | record parsing, include chain walking, lookup counting |
| `server/scripts/check-dns.js` | `npm run check:dns` |
| `server/scripts/dns-plan.js` | `npm run dns:plan` |
| `server/src/workers/sender.js` | hourly re-check and the auto-pause |

To add a third provider, add an entry to `PROVIDERS` — the checks, the
dashboard and the planner all read from it, so nothing else needs changing.
