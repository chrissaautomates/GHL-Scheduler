// GHL Campaign Scheduler
// Runs once a day (via Railway cron). Reads data/nurture.csv and data/cold.csv,
// finds every contact whose "Sequence Start Date" is today, creates or finds
// them in GHL, and enrolls them in the correct workflow via the GHL API.
//
// Required environment variables (set in Railway, not in this file):
//   GHL_API_KEY               Private Integration Token (Settings > Private Integrations in GHL)
//   GHL_LOCATION_ID           Your GHL sub-account (location) ID
//   GHL_NURTURE_WORKFLOW_ID   Workflow ID for the 8-week nurture sequence
//   GHL_COLD_WORKFLOW_ID      Workflow ID for the 4-touch cold sequence
//   GHL_ENGAGE_OCT_WORKFLOW_ID  Optional. Workflow for the one-time "Try DMA Engage, October" send
//   ENGAGE_OCT_RAMP             Optional. Daily volumes by day, last repeats. Default "700,1000,1500"
//   ENGAGE_OCT_INCLUDE_COLD_90PLUS  Optional. "true" adds cold_90plus after warm_90. Default off
//   ENGAGE_OCT_START / ENGAGE_OCT_END  Optional. Send window, default 2026-10-27 to 2026-11-30
//   ENGAGE_OCT_PAUSE            Optional. "true" stops the send without enrolling anyone
//   ENGAGE_OCT_IGNORE_STATS     Optional. "true" resumes after a bounce/complaint pause
//   ENGAGE_OCT_WORKFLOW_CONFIRMED  Optional. "true" lets the send run when GHL cannot confirm the workflow is published
//   ENGAGE_OCT_TEST_EMAIL       Optional. Canary: enroll only this address, ignore the ramp, write no sent tag
//   GHL_API_VERSION           Optional. Defaults to 2021-07-28
//   DRY_RUN                   Optional. Set to "true" to log actions without calling the API

console.log("Boot: process starting, node", process.version);

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err && err.stack ? err.stack : err);
  process.exit(1);
});

import { readFileSync, existsSync } from "fs";
import { buildCreatePayload } from "./contact-payload.js";
import {
  runBatch, orderCandidates, dailyLimit, parseRamp, parseBool, evaluateStats, createThrottle, retry,
  workflowState, workflowGate,
  SENT_TAG, DEFAULT_START, DEFAULT_END,
} from "./engage-oct.js";

let parse;
try {
  ({ parse } = await import("csv-parse/sync"));
  console.log("Boot: csv-parse loaded OK");
} catch (err) {
  console.error("Boot: failed to load csv-parse/sync:", err && err.stack ? err.stack : err);
  process.exit(1);
}

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";
const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const WORKFLOWS = {
  nurture: process.env.GHL_NURTURE_WORKFLOW_ID,
  cold: process.env.GHL_COLD_WORKFLOW_ID,
  // Newsletter is optional: only runs once GHL_NEWSLETTER_WORKFLOW_ID is set
  // and data/newsletter.csv exists, so this deploy doesn't break the
  // existing cold/nurture cron until that workflow is ready in GHL.
  newsletter: process.env.GHL_NEWSLETTER_WORKFLOW_ID,
  // Recurring30 is optional in the same way: only runs once
  // GHL_RECURRING30_WORKFLOW_ID is set and data/recurring30.csv exists.
  recurring30: process.env.GHL_RECURRING30_WORKFLOW_ID,
  // Engage October is optional: only runs when GHL_ENGAGE_OCT_WORKFLOW_ID is
  // set, data/engage-oct.csv exists, and today is inside the send window.
  engageOct: process.env.GHL_ENGAGE_OCT_WORKFLOW_ID,
};

function todayISO() {
  // Assumes Railway service timezone is UTC by default; adjust if you set a TZ var.
  return new Date().toISOString().slice(0, 10);
}

function loadCohort(path, trackName) {
  const raw = readFileSync(path, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  const today = todayISO();
  const todaysRows = rows.filter((r) => r["Sequence Start Date"] === today);
  console.log(`[${trackName}] ${rows.length} total rows, ${todaysRows.length} scheduled for today (${today})`);
  return todaysRows;
}

async function ghlFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Version: API_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${body}`);
    err.status = res.status;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function findContactByEmail(email) {
  const result = await ghlFetch(`/contacts/search`, {
    method: "POST",
    body: JSON.stringify({
      locationId: LOCATION_ID,
      filters: [{ field: "email", operator: "eq", value: email }],
      pageLimit: 1,
    }),
  });
  return result?.contacts?.[0] || null;
}

async function createContact(row) {
  const payload = buildCreatePayload(row, LOCATION_ID);
  const result = await ghlFetch(`/contacts/`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result.contact;
}

async function enrollInWorkflow(contactId, workflowId) {
  return ghlFetch(`/contacts/${contactId}/workflow/${workflowId}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function addTag(contactId, tag) {
  return ghlFetch(`/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: [tag] }),
  });
}

// No confirmed GHL endpoint returns per-batch bounce/complaint counts, so this
// reports "unavailable" and the guard stays inactive until one is wired in here.
// It must return { sent, delivered, bounced, complaints, unsubscribed } or null.
async function fetchPreviousBatchStats() {
  return null;
}

// Published workflows only. Returns "active" | "inactive" | "unknown"; any API
// failure (missing scope, network) is "unknown", never a guess.
async function checkWorkflowState(workflowId) {
  try {
    const res = await ghlFetch(`/workflows/?locationId=${encodeURIComponent(LOCATION_ID)}`);
    return workflowState(res?.workflows, workflowId);
  } catch (err) {
    console.error(`[engage-oct] workflow status lookup failed: ${err.message}`);
    return "unknown";
  }
}

// One paginated read of every contact already carrying SENT_TAG, so the run can
// skip them without a lookup each. Returns a Set of lowercase emails, or null
// when it could not be read completely. null is safe: runBatch still checks the
// tag on every contact it is about to enroll.
async function fetchSentEmails() {
  const pageLimit = 100;
  const emails = new Set();
  try {
    let total = Infinity;
    for (let page = 1; emails.size < total && page <= 500; page++) {
      const res = await ghlFetch(`/contacts/search`, {
        method: "POST",
        body: JSON.stringify({
          locationId: LOCATION_ID,
          filters: [{ field: "tags", operator: "contains", value: [SENT_TAG] }],
          page,
          pageLimit,
        }),
      });
      const contacts = res?.contacts || [];
      if (typeof res?.total === "number") total = res.total;
      contacts.forEach((c) => c.email && emails.add(String(c.email).toLowerCase()));
      if (contacts.length < pageLimit) break;
    }
    return emails;
  } catch (err) {
    console.error(`[engage-oct] could not read already-sent contacts: ${err.message}`);
    return null;
  }
}

// Takes the next `limit` contacts that do not carry SENT_TAG, in segment order.
// The tag is the ledger: it is added right after each successful enrollment,
// so a rerun skips everyone already sent. With ENGAGE_OCT_TEST_EMAIL set this is
// a canary: only that address, no ramp, no tag.
async function processEngageOct(workflowId, limit) {
  const includeCold = parseBool(process.env.ENGAGE_OCT_INCLUDE_COLD_90PLUS);
  const testEmail = (process.env.ENGAGE_OCT_TEST_EMAIL || "").trim().toLowerCase();
  const canary = testEmail !== "";
  const rows = parse(readFileSync("data/engage-oct.csv", "utf8"), { columns: true, skip_empty_lines: true });
  let candidates = orderCandidates(rows, { includeCold });
  if (canary) {
    const match = rows.find((r) => String(r.Email || "").trim().toLowerCase() === testEmail);
    candidates = [match || { Email: testEmail }];
    limit = 1;
  }
  const mode = canary ? `CANARY(${testEmail})` : "LIVE";
  const guard = (active) => `guard=${active ? "ACTIVE" : "INACTIVE"}`;
  let guardActive = false;
  const finish = (r) => {
    const reasons = {};
    r.skipped.forEach((s) => { reasons[s.reason] = (reasons[s.reason] || 0) + 1; });
    console.log(`[engage-oct] END mode=${mode} ${guard(guardActive)} attempted=${r.attempted} enrolled=${r.enrolled} skipped=${r.skipped.length} failed=${r.failed} halted=${r.halted} skipReasons=${JSON.stringify(reasons)}`);
    if (r.halted) process.exitCode = 1;
    return r;
  };
  const refused = { attempted: 0, enrolled: 0, failed: 0, skipped: [], halted: true };

  console.log(`[engage-oct] START mode=${mode} ${guard(false)} (no stats source wired) candidates=${candidates.length} cold_90plus=${includeCold ? "ON" : "OFF"} limit=${limit}`);

  if (parseBool(process.env.ENGAGE_OCT_PAUSE)) {
    console.error("[engage-oct] PAUSED by ENGAGE_OCT_PAUSE=true. Nothing enrolled.");
    process.exitCode = 1;
    return finish(refused);
  }

  if (DRY_RUN) {
    candidates.slice(0, limit).forEach((r) =>
      console.log(`[DRY RUN][engage-oct] would check and enroll ${r.Email} into workflow ${workflowId}`));
    return finish({ ...refused, halted: false });
  }

  // Workflow must be confirmed published before anyone is enrolled or tagged.
  const gate = workflowGate(await checkWorkflowState(workflowId), parseBool(process.env.ENGAGE_OCT_WORKFLOW_CONFIRMED));
  console.log(`[engage-oct] workflow ${workflowId}: ${gate.ok ? "OK" : "REFUSED"} - ${gate.reason}`);
  if (!gate.ok) {
    process.exitCode = 1;
    return finish(refused);
  }

  const stats = evaluateStats(await fetchPreviousBatchStats());
  guardActive = stats.available;
  if (!stats.available) {
    console.log("[engage-oct] previous batch stats unavailable from GHL, bounce/complaint guard inactive");
  } else {
    console.log(`[engage-oct] previous batch: bounce ${(stats.bounceRate * 100).toFixed(2)}%, complaints ${(stats.complaintRate * 100).toFixed(2)}%, unsubscribed ${(stats.unsubscribeRate * 100).toFixed(2)}%`);
    if (stats.pause && !parseBool(process.env.ENGAGE_OCT_IGNORE_STATS)) {
      console.error(`[engage-oct] PAUSED: ${stats.reasons.join("; ")}. Nothing enrolled. Set ENGAGE_OCT_IGNORE_STATS=true to resume.`);
      process.exitCode = 1;
      return finish(refused);
    }
  }

  // 150 ms between calls is ~66 requests per 10 s, under GHL's burst limit.
  const throttle = createThrottle(150);
  const call = (fn, opts) => retry(async () => { await throttle(); return fn(); }, opts);

  const alreadySent = (await fetchSentEmails()) || new Set();
  console.log(`[engage-oct] ${alreadySent.size} contacts already carry ${SENT_TAG}`);

  const result = await runBatch({
    candidates,
    limit,
    alreadySent,
    workflowConfirmed: true,
    canary,
    lookup: (email) => call(() => findContactByEmail(email)),
    create: (row) => call(() => createContact(row), { idempotent: false }),
    enroll: (id) => call(() => enrollInWorkflow(id, workflowId), { idempotent: false }),
    tag: (id) => call(() => addTag(id, SENT_TAG)),
    log: (msg) => console.error(`[engage-oct] ${msg}`),
  });

  // Already-sent skips are expected (thousands by mid-send); list only the rest.
  result.skipped.filter((s) => s.reason !== "already-tagged")
    .forEach((s) => console.log(`[engage-oct] SKIPPED ${s.email}: ${s.reason}`));
  return finish(result);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processTrack(rows, trackName, workflowId) {
  let created = 0, found = 0, enrolled = 0, failed = 0;

  for (const row of rows) {
    try {
      if (DRY_RUN) {
        console.log(`[DRY RUN][${trackName}] would enroll ${row.Email} into workflow ${workflowId}`);
        continue;
      }

      let contact = await findContactByEmail(row.Email);
      if (contact) {
        found++;
      } else {
        contact = await createContact(row);
        created++;
      }

      await enrollInWorkflow(contact.id, workflowId);
      enrolled++;
    } catch (err) {
      failed++;
      console.error(`[${trackName}] FAILED for ${row.Email}: ${err.message}`);
    }

    // Basic pacing to stay well under GHL's burst rate limit.
    await sleep(300);
  }

  console.log(`[${trackName}] done. created=${created} matched_existing=${found} enrolled=${enrolled} failed=${failed}`);
  return { created, found, enrolled, failed };
}

async function main() {
  console.log("Boot: entering main()");
  console.log(`=== GHL Campaign Scheduler run for ${todayISO()} ===`);

  if (!DRY_RUN && (!API_KEY || !LOCATION_ID)) {
    console.error("Missing GHL_API_KEY or GHL_LOCATION_ID. Set DRY_RUN=true to test without them.");
    process.exit(1);
  }
  const canaryOnly = (process.env.ENGAGE_OCT_TEST_EMAIL || "").trim() !== "";
  if (canaryOnly) {
    // Canary runs only the engage-oct path so no other track's rows are touched.
    if (!WORKFLOWS.engageOct || !existsSync("data/engage-oct.csv")) {
      console.error("Canary needs GHL_ENGAGE_OCT_WORKFLOW_ID and data/engage-oct.csv.");
      process.exit(1);
    }
    await processEngageOct(WORKFLOWS.engageOct, 1);
    return;
  }
  if (!DRY_RUN && (!WORKFLOWS.nurture || !WORKFLOWS.cold)) {
    console.error("Missing GHL_NURTURE_WORKFLOW_ID or GHL_COLD_WORKFLOW_ID.");
    process.exit(1);
  }

  const nurtureRows = loadCohort("data/nurture.csv", "nurture");
  const coldRows = loadCohort("data/cold.csv", "cold");

  const nurtureResult = await processTrack(nurtureRows, "nurture", WORKFLOWS.nurture);
  const coldResult = await processTrack(coldRows, "cold", WORKFLOWS.cold);

  // Newsletter: one-time enrollment per contact (Sequence Start Date only
  // ever matches once). Recurrence after that lives entirely inside the GHL
  // workflow itself (Send -> Wait 30 Days -> loop with re-entry allowed),
  // so this script never needs to re-enroll anyone for it.
  let newsletterResult = { created: 0, found: 0, enrolled: 0, failed: 0 };
  if (WORKFLOWS.newsletter && existsSync("data/newsletter.csv")) {
    const newsletterRows = loadCohort("data/newsletter.csv", "newsletter");
    newsletterResult = await processTrack(newsletterRows, "newsletter", WORKFLOWS.newsletter);
  } else {
    console.log("[newsletter] skipped (GHL_NEWSLETTER_WORKFLOW_ID not set or data/newsletter.csv missing)");
  }

  // Recurring30: same one-time-enrollment pattern as newsletter. The 30-day
  // repeat lives entirely inside the GHL workflow (Send -> Wait 30 Days ->
  // loop with re-entry allowed), so this script never re-enrolls anyone.
  let recurring30Result = { created: 0, found: 0, enrolled: 0, failed: 0 };
  if (WORKFLOWS.recurring30 && existsSync("data/recurring30.csv")) {
    const recurring30Rows = loadCohort("data/recurring30.csv", "recurring30");
    recurring30Result = await processTrack(recurring30Rows, "recurring30", WORKFLOWS.recurring30);
  } else {
    console.log("[recurring30] skipped (GHL_RECURRING30_WORKFLOW_ID not set or data/recurring30.csv missing)");
  }

  // Engage October: one-time send, ramped daily volume from ENGAGE_OCT_START.
  let engageOctResult = null;
  const ramp = parseRamp(process.env.ENGAGE_OCT_RAMP);
  const engageStart = process.env.ENGAGE_OCT_START || DEFAULT_START;
  const engageEnd = process.env.ENGAGE_OCT_END || DEFAULT_END;
  const engageLimit = dailyLimit(todayISO(), ramp, engageStart, engageEnd);
  if (WORKFLOWS.engageOct && existsSync("data/engage-oct.csv") && engageLimit > 0) {
    engageOctResult = await processEngageOct(WORKFLOWS.engageOct, engageLimit);
  } else {
    console.log(`[engage-oct] skipped (GHL_ENGAGE_OCT_WORKFLOW_ID not set, data/engage-oct.csv missing, or ${todayISO()} outside ${engageStart}..${engageEnd})`);
  }

  console.log("=== Summary ===");
  console.log("Nurture:", nurtureResult);
  console.log("Cold:", coldResult);
  console.log("Newsletter:", newsletterResult);
  console.log("Recurring30:", recurring30Result);
  if (engageOctResult) console.log("EngageOct:", engageOctResult);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
