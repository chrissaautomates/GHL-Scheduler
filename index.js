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
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${body}`);
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
  const payload = {
    locationId: LOCATION_ID,
    email: row.Email,
    firstName: row["First Name"] || undefined,
    companyName: row["Business Name"] || undefined,
    tags: row.Trigger_Tag ? [row.Trigger_Tag] : undefined,
  };
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

  console.log("=== Summary ===");
  console.log("Nurture:", nurtureResult);
  console.log("Cold:", coldResult);
  console.log("Newsletter:", newsletterResult);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
