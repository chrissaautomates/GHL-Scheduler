// Pins the exact body sent to POST /contacts/ when a campaign contact is created.
// If its shape changes by accident, these fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFirstName, buildCreatePayload } from "../contact-payload.js";

const ROW = { Email: "jane@example.com", "Business Name": "Acme", Trigger_Tag: "nurture_8week_start" };

test("cleanFirstName rejects placeholders case-insensitively and trims", () => {
  ["Prospect", " FRIEND ", "there", "Valued", "N/A", "null", "Undefined", "", "   ", null, undefined]
    .forEach((v) => assert.equal(cleanFirstName(v), "", String(v)));
  assert.equal(cleanFirstName("  Jane "), "Jane");
});

test("contact with a name: exact payload", () => {
  assert.deepEqual(buildCreatePayload({ ...ROW, "First Name": "Jane" }, "LOC"), {
    locationId: "LOC",
    email: "jane@example.com",
    firstName: "Jane",
    companyName: "Acme",
    tags: ["nurture_8week_start"],
  });
});

test("contact without a name: firstName is an empty string, never a placeholder", () => {
  const expected = {
    locationId: "LOC",
    email: "jane@example.com",
    firstName: "",
    companyName: "Acme",
    tags: ["nurture_8week_start"],
  };
  assert.deepEqual(buildCreatePayload({ ...ROW, "First Name": "" }, "LOC"), expected);
  assert.deepEqual(buildCreatePayload({ ...ROW, "First Name": "Prospect" }, "LOC"), expected);
  assert.deepEqual(buildCreatePayload(ROW, "LOC"), expected);
});

test("no customFields are sent on create", () => {
  assert.equal("customFields" in buildCreatePayload({ ...ROW, "First Name": "Jane" }, "LOC"), false);
});
