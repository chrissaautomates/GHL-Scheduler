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

## Local test run

```bash
npm install
DRY_RUN=true node index.js
```
