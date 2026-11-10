# Cold outreach sequence playbook

How the `sequence` templates are meant to be used, and why they are written
the way they are.

**If you are an AI assistant asked to "improve" these templates: read the
Design section first.** The plainness is the design. Adding a header bar, a
brand colour or a "Book a demo" button will make the preview look better and
the campaign perform worse.

---

## The eight rules the copy follows

1. **Lead with the customer's problem, not our features.** Open on what their
   week looks like, then introduce the product as one possible answer.
2. **Personalise from evidence, not assumption.** "I noticed you do technical
   recruitment" could go to a hundred companies. "Your current openings
   include Java developers, DevOps engineers and data professionals" could
   not.
3. **Keep it short.** The first email creates interest. It does not explain
   the product. Save the walkthrough for the call.
4. **Sell the outcome, not the AI.** Recruiter time back, consistent
   evaluation, better information before submitting to a client. The AI is
   the mechanism, not the pitch.
5. **Make the ask small.** A question about how they work, not a demo
   booking. There is deliberately **no link** in any of these templates.
6. **Follow up with substance.** Four messages, each with its own reason to
   exist, not four copies of "just checking in".
7. **Target recurring problems.** A staffing agency with ten open technical
   roles has the problem every week. A company hiring one developer does not.
8. **Every prospect needs a reason to be on the list.** Before sending, you
   should be able to finish: *I believe [Company] might benefit from this
   because ______* — with something you actually verified.

---

## The five steps

| # | Template | Wait | What it does |
|---|---|---|---|
| 1 | `outreach-01-opener` | — | Problem first, evidence-personalised, ends on a question |
| 2 | `outreach-02-reminder` | 3d | Short nudge, same thread |
| 3 | `outreach-03-their-process` | 4d | Asks how they screen today |
| 4 | `outreach-04-use-case` | 5d | One concrete scenario in their domain |
| 5 | `outreach-05-break-up` | 6d | Closes the loop, asks for nothing |

Waits are **calendar** days, but the sender skips weekends, so these land at
roughly the 2–3 / 3–4 / 4–5 business-day spacing the rules call for.

The break-up often gets the highest reply rate of the five. That is not a
trick — it reads as honest because it is, and it asks for nothing.

### The sequence stops itself

You do not need to manage this. The sequencer exits a contact's enrollment
the moment they reply, unsubscribe, bounce or are suppressed, and it
re-checks immediately before enqueuing each step. Nobody gets "just bumping
this" after they have already answered.

Follow-ups thread onto step 1 via `In-Reply-To` and `References`, and their
subject is prefixed `Re:` automatically.

---

## The research schema

Rule 2 only works if somebody did the research. These are the CSV columns
that carry it.

| Column | Required | Example |
|---|---|---|
| `email` | yes | `dana@abcconsultants.com` |
| `first_name` | yes | `Dana` |
| `company` | yes | `ABC Consultants` |
| `observation` | **yes** | `your current openings include Java developers, DevOps engineers and data professionals` |
| `role_examples` | **yes** | `Java developers` |
| `segment` | recommended | `it-staffing` |

`observation` is written to drop into the sentence *"I noticed that
{{observation}}."* — so write it lowercase, no leading capital, no trailing
full stop. It must be something you verified on their site or job board, not
a guess.

`role_examples` drops into *"recruiting several {{role_examples}} for
different client requirements"* — so a plural noun phrase.

### Unfilled fields are blocked, not sent

Leave a column blank and the prospect would receive the literal text
`{{observation}}`. The campaign-start check prevents that: it audits every
step against every recipient and refuses to start, naming the fields, the
counts and example addresses.

```
400  "12 of 340 contacts are missing data this campaign uses"
     {{observation}} - 12 missing of 340 contacts (e.g. a@x.com, b@y.com)
```

A blank value counts as missing, because *"I noticed that ."* is as broken as
the raw syntax, just differently.

See `server/src/lib/merge-fields.js` and `server/test/merge-fields.test.js`.

---

## Who to put on the list

| Prospect | Priority | Why |
|---|---|---|
| IT staffing agency, many open technical roles | High | Recurring screening load |
| RPO running several client accounts | High | Needs consistent evaluation |
| General HR consultancy doing payroll | Low | Screening is not their core work |
| Company hiring one developer | Low | No recurring volume |

Rule 7 in practice: a hundred companies with "recruitment" on the website is
not a list. Thirty with evidence of repeated technical hiring is.

Put the priority in the `segment` column so the low-priority rows can be
filtered out before import, rather than mailed and ignored.

---

## Design

Plain on purpose. No images, no buttons, no colour blocks, no header bar.
System fonts, one thin rule above the signature.

This is not laziness, and it is measurable. The repo previously carried
seven designed templates - gradient headers, CTA buttons, stat blocks. Run
through the built-in spam linter alongside these, before they were removed:

```
outreach-01-opener         sequence      100   0 warnings   0 links
outreach-02-reminder       sequence      100   0 warnings   0 links
outreach-03-their-process  sequence      100   0 warnings   0 links
outreach-04-use-case       sequence      100   0 warnings   0 links
outreach-05-break-up       sequence      100   0 warnings   0 links
dark-professional          professional   92   1 warning    7 links
modern-gradient-pro        professional   84   2 warnings   9 links
newsletter-modern          newsletter     84   2 warnings   9 links
```

The gap is link count and markup weight. For a cold first contact, a
designed template says "this is a campaign" before a word is read - which
works against rules 1 through 5 at the same time as it works against inbox
placement.

**Those seven were deleted deliberately.** They were only ever right for warm
audiences - existing clients, newsletters, announcements - and this service
sends cold outreach. Leaving them in the picker meant a rep could pick one
for a prospecting campaign and quietly undo everything above. They are in
git history if a newsletter is ever needed:

```bash
git log --diff-filter=D --name-only -- server/src/templates
```

### Editing the copy

The signature block reads `[Your Name]` / `IterateX`. Replace it once per
campaign in the editor; it is not a merge field, because it varies by sender
rather than by recipient.

Keep each message under roughly 120 words. If a message needs more, it
probably belongs on the call.

---

## Setting up the campaign

1. Import the CSV with the research columns above.
2. New campaign → pick a category, pick the list.
3. Add five steps, pasting each template in order, with waits 0 / 3 / 4 / 5 / 6.
4. Subject on step 1 only; leave the follow-up subjects blank so they inherit
   it and get `Re:`.
5. Send a test to yourself and read it on a phone.
6. Start. If merge data is missing it will refuse, and tell you what to fix.

### Before the first real campaign

- `COMPANY_POSTAL_ADDRESS` must be a real registered address — it is legally
  required and it blocks campaign start until set.
- Check `sequenceWaitUnit` in settings is **days**, not minutes. Minutes is a
  testing mode that fires an entire sequence within the hour.
- Warm-up should be on for a new sending domain.
