// Pins segment order, the 300 cap, the tag ledger skip, and the exclusions
// for the one-time Engage October send.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBatch, orderCandidates, localExclusion, contactExclusion, dailyLimit, parseRamp, evaluateStats,
  createThrottle, retry, workflowState, workflowGate, SENT_TAG,
} from "../engage-oct.js";

const row = (n, segment) => ({ Email: `u${n}@corp.com`, segment });

function harness(contacts = {}) {
  const calls = { enroll: [], tag: [], create: [] };
  return {
    calls,
    deps: {
      workflowConfirmed: true,
      lookup: async (email) => contacts[email] || null,
      create: async (r) => { calls.create.push(r.Email); return { id: `new-${r.Email}`, tags: [] }; },
      enroll: async (id) => { calls.enroll.push(id); },
      tag: async (id) => { calls.tag.push(id); },
    },
  };
}

test("segment order: engaged, hot_30, warm_90, then cold_90plus only when on; unknown dropped; repeats dropped", () => {
  const rows = [
    row(1, "cold_90plus"), row(2, "warm_90"), row(3, "engaged"), row(4, "unknown"),
    row(5, "hot_30"), row(6, "warm_90"), row(7, "engaged"), { ...row(8, "hot_30"), Email: "U5@corp.com" },
  ];
  assert.deepEqual(orderCandidates(rows).map((r) => r.Email), [
    "u3@corp.com", "u7@corp.com", "u5@corp.com", "u2@corp.com", "u6@corp.com",
  ]);
  assert.deepEqual(orderCandidates(rows, { includeCold: true }).map((r) => r.Email).slice(-1), ["u1@corp.com"]);
});

test("daily volume ramp: 700, 1000, then 1500; nothing before start or after end", () => {
  assert.equal(dailyLimit("2026-10-26"), 0);
  assert.equal(dailyLimit("2026-10-27"), 700);
  assert.equal(dailyLimit("2026-10-28"), 1000);
  assert.equal(dailyLimit("2026-10-29"), 1500);
  assert.equal(dailyLimit("2026-11-20"), 1500);
  assert.equal(dailyLimit("2026-12-01"), 0);
  assert.equal(dailyLimit("2026-10-28", [5, 9]), 9);
  assert.deepEqual(parseRamp("100, 200"), [100, 200]);
  assert.deepEqual(parseRamp(undefined), [700, 1000, 1500]);
  assert.throws(() => parseRamp("100,abc"));
});

test("ramp list is the cap: runBatch stops at the day's limit", async () => {
  const candidates = Array.from({ length: 2000 }, (_, i) => row(i, "engaged"));
  const { calls, deps } = harness();
  const res = await runBatch({ candidates, limit: dailyLimit("2026-10-27"), ...deps });
  assert.equal(res.enrolled, 700);
  assert.equal(calls.tag.length, 700);
});

test("ledger: contacts tagged engage-oct-sent are skipped and the cap fills from later rows", async () => {
  const candidates = Array.from({ length: 400 }, (_, i) => row(i, "engaged"));
  const contacts = {};
  for (let i = 0; i < 100; i++) contacts[`u${i}@corp.com`] = { id: `c${i}`, tags: ["Other", SENT_TAG.toUpperCase()] };
  const { calls, deps } = harness(contacts);
  const res = await runBatch({ candidates, limit: 300, ...deps });
  assert.equal(res.skipped.filter((s) => s.reason === "already-tagged").length, 100);
  assert.equal(calls.enroll.length, 300);
  assert.ok(!calls.enroll.includes("c0"));
});

test("a rerun after a full run enrolls nobody", async () => {
  const candidates = Array.from({ length: 50 }, (_, i) => row(i, "engaged"));
  const contacts = {};
  const { calls, deps } = harness(contacts);
  deps.tag = async (id) => { calls.tag.push(id); contacts[id.replace("new-", "")] = { id, tags: [SENT_TAG] }; };
  await runBatch({ candidates, limit: 300, ...deps });
  const second = harness(contacts);
  const res = await runBatch({ candidates, limit: 300, ...second.deps });
  assert.equal(res.enrolled, 0);
  assert.equal(second.calls.enroll.length, 0);
});

test("tag is added after enroll, only on success", async () => {
  const order = [];
  const res = await runBatch({
    candidates: [row(1, "engaged"), row(2, "engaged")],
    limit: 300,
    workflowConfirmed: true,
    lookup: async (email) => ({ id: `c-${email}`, tags: [] }),
    create: async () => { throw new Error("unused"); },
    enroll: async (id) => { order.push("enroll"); if (order.length > 2) throw new Error("boom"); },
    tag: async () => { order.push("tag"); },
  });
  assert.deepEqual(order, ["enroll", "tag", "enroll"]);
  assert.equal(res.failed, 1);
  assert.equal(res.enrolled, 1);
});

test("a failed tag halts the run so nobody can be double-sent", async () => {
  const { calls, deps } = harness();
  deps.tag = async () => { throw new Error("tag down"); };
  const res = await runBatch({ candidates: [row(1, "engaged"), row(2, "engaged")], limit: 300, ...deps });
  assert.equal(res.halted, true);
  assert.equal(calls.enroll.length, 1);
});

test("exclusions: email DND / unsubscribed, invalid email, test and plus-test addresses", async () => {
  assert.equal(contactExclusion({ tags: [], dndSettings: { Email: { status: "active" } } }), "email-dnd");
  assert.equal(contactExclusion({ tags: [], dndSettings: { Email: { status: "inactive" } } }), null);
  assert.equal(contactExclusion({ tags: [], validEmail: false }), "invalid-email");
  assert.equal(contactExclusion(null), null);
  assert.equal(localExclusion("test@example.com"), "test-address");
  assert.equal(localExclusion("jane+test@gmail.com"), "test-address");
  assert.equal(localExclusion("jane+testjane@gmail.com"), "test-address");
  assert.equal(localExclusion("test@corp.com"), "test-address");
  assert.equal(localExclusion("not-an-email"), "invalid-email");
  assert.equal(localExclusion(""), "missing-email");
  assert.equal(localExclusion("jane@corp.com"), null);

  const contacts = {
    "u1@corp.com": { id: "a", tags: [], dndSettings: { Email: { status: "active" } } },
    "u2@corp.com": { id: "b", tags: [], validEmail: false },
  };
  const { calls, deps } = harness(contacts);
  const res = await runBatch({
    candidates: [row(1, "engaged"), row(2, "engaged"), { Email: "x+test@gmail.com", segment: "engaged" }, row(3, "engaged")],
    limit: 300,
    ...deps,
  });
  assert.deepEqual(res.skipped.map((s) => s.reason), ["email-dnd", "invalid-email", "test-address"]);
  assert.deepEqual(calls.create, ["u3@corp.com"]);
});

test("same contact reached through two emails is enrolled once", async () => {
  const { calls, deps } = harness();
  deps.lookup = async () => ({ id: "same", tags: [] });
  const res = await runBatch({ candidates: [row(1, "engaged"), row(2, "engaged")], limit: 300, ...deps });
  assert.deepEqual(calls.enroll, ["same"]);
  assert.equal(res.skipped[0].reason, "duplicate-contact");
});

test("stats guard: pauses above 3% bounce or 0.3% complaints, inactive without stats", () => {
  assert.equal(evaluateStats(null).available, false);
  assert.equal(evaluateStats({ sent: 1000, delivered: 980, bounced: 30, complaints: 2 }).pause, false);
  assert.equal(evaluateStats({ sent: 1000, delivered: 960, bounced: 31, complaints: 0 }).pause, true);
  const c = evaluateStats({ sent: 1000, delivered: 1000, bounced: 0, complaints: 4, unsubscribed: 10 });
  assert.equal(c.pause, true);
  assert.equal(c.unsubscribeRate, 0.01);
});

test("retry: 429 retried always; 5xx only when idempotent; gives up after attempts", async () => {
  const err = (status) => Object.assign(new Error("x"), { status });
  const sleep = async () => {};
  let n = 0;
  assert.equal(await retry(async () => { if (++n < 3) throw err(429); return "ok"; }, { sleep }), "ok");
  n = 0;
  assert.equal(await retry(async () => { if (++n < 2) throw err(503); return "ok"; }, { sleep }), "ok");
  n = 0;
  await assert.rejects(retry(async () => { n++; throw err(503); }, { sleep, idempotent: false }));
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(retry(async () => { n++; throw err(429); }, { sleep, attempts: 3 }));
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(retry(async () => { n++; throw err(400); }, { sleep }));
  assert.equal(n, 1);
});

test("throttle spaces calls by the minimum interval", async () => {
  let t = 0;
  const waits = [];
  const wait = createThrottle(150, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  await wait(); await wait(); await wait();
  assert.deepEqual(waits, [150, 150]);
});

test("workflow gate: published passes, draft always refuses, unverifiable needs the override", () => {
  const list = [{ id: "a", status: "published" }, { id: "b", status: "draft" }, { id: "c" }];
  assert.equal(workflowState(list, "a"), "active");
  assert.equal(workflowState(list, "b"), "inactive");
  assert.equal(workflowState(list, "c"), "unknown");
  assert.equal(workflowState(list, "zzz"), "unknown");
  assert.equal(workflowState(undefined, "a"), "unknown");
  assert.equal(workflowGate("active", false).ok, true);
  assert.equal(workflowGate("inactive", true).ok, false);
  assert.equal(workflowGate("unknown", false).ok, false);
  assert.equal(workflowGate("unknown", true).ok, true);
});

test("runBatch refuses to enroll or tag anyone when the workflow is not confirmed", async () => {
  const { calls, deps } = harness();
  await assert.rejects(runBatch({ candidates: [row(1, "engaged")], limit: 5, ...deps, workflowConfirmed: false }));
  assert.equal(calls.enroll.length, 0);
  assert.equal(calls.tag.length, 0);
});

test("canary: enrolls the one address, writes no sent tag, ignores an existing tag", async () => {
  const contacts = { "u1@corp.com": { id: "c1", tags: [SENT_TAG] } };
  const { calls, deps } = harness(contacts);
  const logs = [];
  const res = await runBatch({ candidates: [row(1, "engaged")], limit: 1, ...deps, canary: true, alreadySent: new Set(["u1@corp.com"]), log: (m) => logs.push(m) });
  assert.deepEqual(calls.enroll, ["c1"]);
  assert.equal(calls.tag.length, 0);
  assert.equal(res.enrolled, 1);
  assert.match(logs[0], /CANARY enrolled u1@corp.com/);
});

test("bulk sent set skips without a lookup; a contact missing from the set is still caught by its tag", async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => row(i, "engaged"));
  let lookups = 0;
  const { calls, deps } = harness({ "u5@corp.com": { id: "c5", tags: [SENT_TAG] } });
  const inner = deps.lookup;
  deps.lookup = async (e) => { lookups++; return inner(e); };
  const sent = new Set(["u0@corp.com", "u1@corp.com", "u2@corp.com"]);
  const res = await runBatch({ candidates, limit: 300, alreadySent: sent, ...deps });
  assert.equal(lookups, 7);
  assert.ok(!calls.create.includes("u0@corp.com"));
  assert.ok(!calls.enroll.includes("c5"));
  assert.equal(res.skipped.filter((s) => s.reason === "already-tagged").length, 4);
  assert.equal(res.attempted, 10);
  assert.equal(res.enrolled, 6);
});
