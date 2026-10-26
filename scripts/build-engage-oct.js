// One-off: builds data/engage-oct.csv from data/recurring30.csv.
// Engaged, hot_30, warm_90, cold_90plus (unknown dropped); test and malformed addresses removed and listed
// in data/engage-oct-skipped.csv. Usage: node scripts/build-engage-oct.js
import { readFileSync, writeFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { orderCandidates, localExclusion, dailyLimit, DEFAULT_RAMP, DEFAULT_START, SEGMENT_ORDER } from "../engage-oct.js";

// Minimal CSV writer so the repo keeps a single dependency (csv-parse).
const cell = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
const stringify = (records, { header }) => {
  const cols = Object.keys(records[0] || {});
  return [header ? cols.join(",") : null, ...records.map((r) => cols.map((c) => cell(r[c])).join(","))]
    .filter((l) => l !== null).join("\n") + "\n";
};

const rows = parse(readFileSync("data/recurring30.csv", "utf8"), { columns: true, skip_empty_lines: true });
const ordered = orderCandidates(rows, { includeCold: true });

const kept = [];
const skipped = [];
for (const r of ordered) {
  const reason = localExclusion(r.Email);
  if (reason) skipped.push({ Email: r.Email, segment: r.segment, reason });
  else kept.push({
    Email: r.Email.trim(),
    "First Name": r["First Name"],
    "Business Name": r["Business Name"],
    segment: r.segment,
    Trigger_Tag: "engage_oct",
  });
}

writeFileSync("data/engage-oct.csv", stringify(kept, { header: true }));
writeFileSync("data/engage-oct-skipped.csv", stringify(skipped, { header: true }));

const count = (seg) => kept.filter((r) => r.segment === seg).length;
const perSegment = Object.fromEntries(SEGMENT_ORDER.map((s) => [s, count(s)]));
console.log("per segment after exclusions:", perSegment);
console.log("skipped:", skipped.map((r) => `${r.Email} (${r.reason})`));

// Day-by-day finish date at DEFAULT_RAMP, assuming no GHL-time skips.
function finish(total) {
  let left = total, day = DEFAULT_START, n = 0;
  while (left > 0) {
    left -= dailyLimit(day, DEFAULT_RAMP, DEFAULT_START, "9999-12-31");
    n++;
    if (left > 0) day = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
  }
  return { days: n, finishDate: day };
}
const warmOnly = kept.filter((r) => r.segment !== "cold_90plus").length;
console.log(`through warm_90: ${warmOnly} contacts`, finish(warmOnly));
console.log(`with cold_90plus: ${kept.length} contacts`, finish(kept.length));
