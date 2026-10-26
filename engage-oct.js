// Pure logic for the one-time "Newsletter 1, Try DMA Engage, October" send.
// Kept out of index.js (which runs the scheduler on import) so tests can drive it.

export const SENT_TAG = "engage-oct-sent";

// Segment order. cold_90plus is last and only used when explicitly switched on.
export const SEGMENT_ORDER = ["engaged", "hot_30", "warm_90", "cold_90plus"];

// Daily volume by day since START: day 0 = 700, day 1 = 1000, then 1500 until done.
// The last entry repeats. Override with ENGAGE_OCT_RAMP="700,1000,1500".
export const DEFAULT_RAMP = [700, 1000, 1500];
export const DEFAULT_START = "2026-10-27";
// Safety stop so the cron does not rescan the finished list forever.
export const DEFAULT_END = "2026-11-30";

export const THRESHOLDS = { maxBounceRate: 0.03, maxComplaintRate: 0.003 };

export function parseRamp(value, fallback = DEFAULT_RAMP) {
  if (!value) return fallback;
  const ramp = String(value).split(",").map((s) => Number(s.trim()));
  if (!ramp.length || ramp.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`Invalid ENGAGE_OCT_RAMP: ${value}`);
  }
  return ramp;
}

export function parseBool(value) {
  return String(value || "").toLowerCase() === "true";
}

export function activeSegments(includeCold) {
  return includeCold ? SEGMENT_ORDER : SEGMENT_ORDER.filter((s) => s !== "cold_90plus");
}

const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 864e5);

// How many contacts to enroll on `today` (UTC date), 0 outside start..end.
export function dailyLimit(today, ramp = DEFAULT_RAMP, start = DEFAULT_START, end = DEFAULT_END) {
  if (today < start || today > end) return 0;
  return ramp[Math.min(dayNumber(today) - dayNumber(start), ramp.length - 1)];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns the reason an address is excluded before GHL is consulted, or null.
export function localExclusion(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "missing-email";
  if (!EMAIL_RE.test(e)) return "invalid-email";
  const [local, domain] = e.split("@");
  if (/^example\.(com|org|net)$/.test(domain)) return "test-address";
  if (local === "test" || /\+.*test/.test(local)) return "test-address";
  return null;
}

// Orders rows by segment (file order within a segment), drops other segments,
// and drops repeat emails.
export function orderCandidates(rows, { includeCold = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const segment of activeSegments(includeCold)) {
    for (const row of rows) {
      if (row.segment !== segment) continue;
      const key = String(row.Email || "").trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

// Reason a GHL contact must be skipped, or null.
export function contactExclusion(contact, { ignoreSentTag = false } = {}) {
  if (!contact) return null;
  if (!ignoreSentTag && (contact.tags || []).some((t) => String(t).toLowerCase() === SENT_TAG)) return "already-tagged";
  if (contact.validEmail === false) return "invalid-email";
  if (contact.dndSettings?.Email?.status === "active") return "email-dnd";
  return null;
}

// Classifies the GHL workflow list (GET /workflows/?locationId=) for one id:
// "active" (published), "inactive" (draft or any other known status) or
// "unknown" (id not listed, or no usable status).
export function workflowState(workflows, id) {
  const wf = (Array.isArray(workflows) ? workflows : []).find((w) => w?.id === id);
  const status = String(wf?.status || "").toLowerCase();
  if (!status) return "unknown";
  return status === "published" ? "active" : "inactive";
}

// Decides whether the run may enroll. `state` is workflowState() or "unknown"
// when the lookup itself failed. A confirmed-inactive workflow always refuses;
// an unverifiable one refuses unless the operator set ENGAGE_OCT_WORKFLOW_CONFIRMED.
export function workflowGate(state, operatorConfirmed) {
  if (state === "active") return { ok: true, reason: "workflow verified published via GHL API" };
  if (state === "inactive") return { ok: false, reason: "workflow is not published in GHL (draft/inactive)" };
  if (operatorConfirmed) return { ok: true, reason: "workflow could not be verified; trusting ENGAGE_OCT_WORKFLOW_CONFIRMED=true" };
  return { ok: false, reason: "workflow could not be verified via the GHL API; set ENGAGE_OCT_WORKFLOW_CONFIRMED=true after checking it is published" };
}

// Rates for the previous batch and whether to pause. `stats` is
// { sent, delivered, bounced, complaints, unsubscribed } or null when GHL gave none.
export function evaluateStats(stats, thresholds = THRESHOLDS) {
  if (!stats || !stats.sent) return { available: false, pause: false, reasons: [] };
  const delivered = stats.delivered || stats.sent;
  const bounceRate = (stats.bounced || 0) / stats.sent;
  const complaintRate = (stats.complaints || 0) / delivered;
  const unsubscribeRate = (stats.unsubscribed || 0) / delivered;
  const reasons = [];
  if (bounceRate > thresholds.maxBounceRate) reasons.push(`bounce rate ${(bounceRate * 100).toFixed(2)}% > ${thresholds.maxBounceRate * 100}%`);
  if (complaintRate > thresholds.maxComplaintRate) reasons.push(`complaint rate ${(complaintRate * 100).toFixed(2)}% > ${thresholds.maxComplaintRate * 100}%`);
  return { available: true, pause: reasons.length > 0, reasons, bounceRate, complaintRate, unsubscribeRate };
}

// Minimum gap between GHL calls. 150 ms is about 66 requests per 10 s, under
// GHL's burst limit of 100 per 10 s per location.
export function createThrottle(minIntervalMs, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let next = 0;
  return async function wait() {
    const t = now();
    const start = Math.max(t, next);
    next = start + minIntervalMs;
    if (start > t) await sleep(start - t);
  };
}

// Retries 429s on any call (the request was refused, nothing happened). Retries
// 5xx and network errors only when `idempotent`: an enroll or create that failed
// ambiguously must not be repeated.
export async function retry(fn, { attempts = 4, baseMs = 1000, idempotent = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const retriable = err.status === 429 || (idempotent && (err.status === undefined || err.status >= 500));
      if (!retriable || i >= attempts - 1) throw err;
      await sleep(err.retryAfterMs ?? baseMs * 2 ** i);
    }
  }
}

// Walks candidates in order and enrolls until `limit` contacts are enrolled.
// Deps: lookup(email), create(row), enroll(id), tag(id).
// - workflowConfirmed must be true or nothing runs; it is the only way a tag is written.
// - alreadySent is a Set of lowercase emails bulk-fetched with the sent tag. It
//   only SKIPS lookups; anyone not in it still gets the per-contact tag check
//   from lookup() before enrolling, so a stale or partial set cannot cause a re-send.
// - canary never writes the sent tag and ignores an existing one.
// Returns counts plus the skipped list [{ email, reason }]. attempted is every
// candidate examined. A contact id is enrolled at most once per run. A failed
// tag after a successful enroll stops the run.
export async function runBatch({ candidates, limit, lookup, create, enroll, tag, alreadySent = new Set(), workflowConfirmed = false, canary = false, log = () => {} }) {
  if (!workflowConfirmed) throw new Error("runBatch refused: workflow not confirmed active");
  const result = { attempted: 0, enrolled: 0, failed: 0, skipped: [], halted: false };
  const enrolledIds = new Set();
  for (const row of candidates) {
    if (result.enrolled >= limit) break;
    result.attempted++;
    const email = String(row.Email || "").trim();

    const local = localExclusion(email);
    if (local) { result.skipped.push({ email, reason: local }); continue; }
    if (!canary && alreadySent.has(email.toLowerCase())) { result.skipped.push({ email, reason: "already-tagged" }); continue; }

    try {
      let contact = await lookup(email);
      const reason = contactExclusion(contact, { ignoreSentTag: canary });
      if (reason) { result.skipped.push({ email, reason }); continue; }
      if (!contact) contact = await create(row);
      if (enrolledIds.has(contact.id)) { result.skipped.push({ email, reason: "duplicate-contact" }); continue; }
      await enroll(contact.id);
      enrolledIds.add(contact.id);
      result.enrolled++;
      if (canary) { log(`CANARY enrolled ${email} (contact ${contact.id}); sent tag NOT written`); continue; }
      try {
        await tag(contact.id);
      } catch (err) {
        log(`TAG FAILED after enroll for ${email}: ${err.message}. Halting run.`);
        result.halted = true;
        break;
      }
    } catch (err) {
      result.failed++;
      log(`FAILED for ${email}: ${err.message}`);
    }
  }
  return result;
}
