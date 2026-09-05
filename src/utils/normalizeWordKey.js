// Shared normalization for comparing free-text words/names loosely: trim,
// collapse internal whitespace, lowercase. Extracted from
// electron/ops/locationWordDecisions.js (added in #288 for the
// location_unresolved held-conflict "not a place" decision table) so the
// renderer's duplicate-location marker can reuse the SAME normalization
// rather than drifting with a second copy — see
// docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md.
export function normalizeWordKey(word) {
  return String(word ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}
