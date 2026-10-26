# GHL Campaign Scheduler

Runs once a day. Reads `data/nurture.csv` and `data/cold.csv`, finds every
contact whose `Sequence Start Date` column matches today, and enrolls them
into the correct GHL workflow through the GHL API. No manual daily import,
no Custom Date Reminder trigger needed inside GHL, this replaces both.

## One-time setup in GHL

1. **Build the two workflows.** Each one just needs the send/wait steps, no
   trigger required since contacts are enrolled by this script via API:
   - **Nurture workflow** (8-week): Send Email 1 -> Wait 7 Days -> Send Email 2
     -> Wait 7 Days -> ... through Email 8.
   - **Cold workflow** (4-touch): Send Touch 1 -> Wait 2 Days -> Touch 2 ->
     Wait 4 Days -> Touch 3 -> Wait 3 Days -> Touch 4.
   - Publish both. Copy each workflow's ID from its settings/URL.

2. **Create a Private Integration Token.**
   Settings > Private Integrations in your GHL sub-account. Give it these
   scopes at minimum: `contacts.write`, `contacts.readonly`, `workflows.readonly`.
   Copy the token, you'll only see it once.

3. **Find your Location ID.**
   Settings > Business Profile, or it's in your GHL dashboard URL.

## One-time setup in Railway

The project `ghl-campaign-scheduler` already exists. Once this code is
pushed to a GitHub repo and connected:

Set these variables on the service (Railway dashboard > Variables, do this
directly in Railway rather than sharing the token elsewhere):

| Variable | Value |
|---|---|
| `GHL_API_KEY` | the Private Integration Token from step 2 above |
| `GHL_LOCATION_ID` | your Location ID from step 3 |
| `GHL_NURTURE_WORKFLOW_ID` | workflow ID from step 1 |
| `GHL_COLD_WORKFLOW_ID` | workflow ID from step 1 |
| `DRY_RUN` | set to `true` first, confirm the logs look right, then remove it |

The cron schedule is already set in `railway.json` to run at 13:00 UTC
(9am Eastern during daylight saving, 8am during standard time). Change
`cronSchedule` there if you want a different time.

## Testing before it touches real contacts

Set `DRY_RUN=true` in Railway and trigger a manual deploy. It'll log exactly
who it would have enrolled and where, without calling the GHL API at all.
Remove that variable once you're confident, and the next scheduled run goes
live for real.

## What it does NOT do

- It does not send the actual emails, that's entirely GHL's workflow engine
  once a contact is enrolled.
- It does not re-enroll anyone, each contact appears exactly once across
  `data/nurture.csv` and `data/cold.csv` on exactly one date.
- It does not touch the 48 contacts from the business card / event capture
  files, those were intentionally excluded, they're on a separate campaign.

## Newsletter track

A third, optional track. Reads `data/newsletter.csv` the same way as
nurture/cold, but it's a one-time enrollment per contact, not a fixed-length
sequence. Recurrence (monthly resends) lives entirely inside the GHL
workflow: build it as Send Newsletter -> Wait 30 Days -> loop back with
re-entry allowed, publish it, and this script only ever needs to enroll each
contact once. `data/newsletter.csv`'s Sequence Start Dates are staggered
across ~20 days (Oct 1-20, 2026 for the initial list) rather than one giant
single-day batch, so the daily cron isn't trying to process ~14,000 rows in
one run.

Set `GHL_NEWSLETTER_WORKFLOW_ID` in Railway once the workflow is published.
Until that variable is set (or if `data/newsletter.csv` is missing), this
track is skipped and cold/nurture run exactly as before.

## Recurring30 track

A fourth, optional track, following the exact same pattern as newsletter.
Reads `data/recurring30.csv` the same way as the other tracks, and it's a
one-time enrollment per contact via this script, not a fixed-length
sequence. The 30-day repeat lives entirely inside the GHL workflow: build it
as Send -> Wait 30 Days -> loop back with re-entry allowed, publish it, and
this script only ever needs to enroll each contact once.

Set `GHL_RECURRING30_WORKFLOW_ID` in Railway once the workflow is published.
Until that variable is set (or if `data/recurring30.csv` is missing), this
track is skipped and the other tracks run exactly as before.

## Local test run

```bash
npm install
DRY_RUN=true node index.js
```

## Engage October track (one-time send)

Sends "Newsletter 1, Try DMA Engage, October" once per contact. Reads
`data/engage-oct.csv` (built by `node scripts/build-engage-oct.js` from
`data/recurring30.csv`; `unknown` is dropped and test addresses are listed in
`data/engage-oct-skipped.csv`). Order: `engaged`, `hot_30`, `warm_90`, then
`cold_90plus`, which stays off unless `ENGAGE_OCT_INCLUDE_COLD_90PLUS=true`.

Runs only when `GHL_ENGAGE_OCT_WORKFLOW_ID` is set. The workflow ID is
`c8b88064-7203-4370-b952-652681d799c9`: **set `GHL_ENGAGE_OCT_WORKFLOW_ID` to
that value in Railway (service Variables)**. Daily volume comes from
`ENGAGE_OCT_RAMP` (default `700,1000,1500`, day 0 = 2026-10-27, the last
number repeats) until the list is done; `ENGAGE_OCT_END` (default 2026-11-30)
is a safety stop. Remove the workflow variable when the send is finished.

Before enrolling anyone, the run asks the GHL API whether the workflow is
published. A draft workflow always refuses. If GHL cannot confirm it (missing
API scope, workflow not listed, API error) the run refuses unless you set
`ENGAGE_OCT_WORKFLOW_CONFIRMED=true` after checking in GHL that it is
published. A contact is never tagged unless the enrollment succeeded and the
workflow was confirmed.

Each run enrolls the next batch of contacts that do not carry the GHL tag
`engage-oct-sent`, skipping anyone with email DND, an invalid email, or a test
address, and adds that tag right after a successful enrollment. Reruns cannot
double send. At the start of a run, one paginated search reads every contact
already tagged, and those are skipped without a per-contact lookup (about 125
calls instead of thousands by Nov 3 and Nov 6). If that search fails or is
incomplete, nothing is lost: every contact about to be enrolled still has its
tags checked individually first. Skips other than already-tagged are logged as
`[engage-oct] SKIPPED email: reason`.
GHL calls are paced at 150 ms; 429s are retried, and 5xx errors are retried
only for lookups and tags, never for enroll or create.

`ENGAGE_OCT_PAUSE=true` stops the send. A bounce rate above 3% or complaint
rate above 0.3% in the previous batch pauses it (exit code 1) until
`ENGAGE_OCT_IGNORE_STATS=true`; that guard needs batch stats from GHL, which
are not wired in yet, so it is **inactive**. Every run logs one line at each end:

```
[engage-oct] START mode=LIVE guard=INACTIVE ... limit=700
[engage-oct] END mode=LIVE guard=INACTIVE attempted=.. enrolled=.. skipped=.. failed=.. halted=..
```

### Canary

Set `ENGAGE_OCT_TEST_EMAIL=you@example.com` (with the workflow ID).
The run then touches only that address through the real path (lookup, create if
missing, enroll), ignores the ramp and the date window, skips every other track,
and does not write the sent tag. It logs `CANARY enrolled ...` and the END line.
**Remove the variable afterwards**: while it is set, the real send never runs.

### Daily check (you are the stats guard)

Because the guard is inactive, check the previous day's send each morning before
the 13:00 UTC cron:

1. GHL > Marketing > Emails > Statistics (set the date range to yesterday): bounce
   rate must stay under 3% and spam complaints under 0.3%; note unsubscribes.
2. GHL > Automation > Workflows > the Engage October workflow > Stats / Execution
   Logs: enrolled count should match the run's `enrolled=` in the Railway log, and
   there should be no failed email actions.

If either is out of range, set `ENGAGE_OCT_PAUSE=true` in Railway Variables. Pausing
only stops new enrollments; contacts already in the workflow keep going.

| Goal | Railway variable |
| --- | --- |
| Pause the send | `ENGAGE_OCT_PAUSE=true` (remove to resume) |
| Lower daily volume | `ENGAGE_OCT_RAMP=300` (every day sends 300; list e.g. `300,500` for day 0, then 500 onward) |
| Stop for good | remove `GHL_ENGAGE_OCT_WORKFLOW_ID`, or set `ENGAGE_OCT_END` to a past date |
| Resume after the auto-pause | `ENGAGE_OCT_IGNORE_STATS=true` |
