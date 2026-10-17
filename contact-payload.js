// Pure builder for the POST /contacts/ body, kept out of index.js (which runs the
// scheduler on import) so tests can pin the exact payload.

// A placeholder is never a real name: it becomes "" so GHL gets an empty first
// name instead of a fake one.
const PLACEHOLDER_FIRST_NAMES = new Set(["prospect", "friend", "there", "valued", "n/a", "null", "undefined"]);

export function cleanFirstName(value) {
  if (value === null || value === undefined) return "";
  const name = String(value).trim();
  return PLACEHOLDER_FIRST_NAMES.has(name.toLowerCase()) ? "" : name;
}

// firstName is always sent on create: the cleaned name, or "" when missing.
export function buildCreatePayload(row, locationId) {
  return {
    locationId,
    email: row.Email,
    firstName: cleanFirstName(row["First Name"]),
    companyName: row["Business Name"] || undefined,
    tags: row.Trigger_Tag ? [row.Trigger_Tag] : undefined,
  };
}
