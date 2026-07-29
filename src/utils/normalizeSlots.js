// The single read boundary for template_slots rows coming back from
// localClient.list(), which returns raw `SELECT *` output with no coercion
// (electron/main.js). Two column groups need fixing up before any consumer
// touches them:
//
//   flags — rows written via bulk_replace carry it as a JSON.stringify'd
//   string (validateBulkReplaceRows in electron/ops/operations.js only accepts
//   string/null row values, so an object can't be written directly), while
//   rows written field-at-a-time may already hold an object. Parsing here lets
//   every consumer treat `flags` as a plain object regardless of which write
//   path last touched the row.
//
//   is_anchor / is_span_head / is_released — nullable INTEGER columns (added
//   by ALTER TABLE in electron/db/localDb.js with no NOT NULL and no DEFAULT),
//   so the renderer only ever sees 0/1, never false/true. Readers in
//   ScheduleScreen (recalcStats, isActivityTail, getActivityRowSpan,
//   handlePasteClick) and in ScheduleGroupView/ManualBuildView compare
//   strictly against `false`, which no DB-loaded row would otherwise satisfy —
//   a merged slot reloaded from the db rendered its head activity twice, in
//   two unmerged cells, and Open/Filled read 0/0.
//
// NULL is deliberately preserved as NULL: it means "never written", and the
// `=== false` readers correctly treat that as not-a-tail / not-released.
// Coercing it to false would instead mark every pre-migration slot as a
// merged tail.

function toSlotBool(value) {
  if (value === null || value === undefined) return value
  return value === 1 || value === true
}

// Pre-reshape snapshots (see docs/adr/2026-07-28-schedule-flag-findings-reshape.md)
// stamped UNDERSERVED/DISTRIBUTION/WEATHER_RISK onto individual slots. Those
// three kinds are now computed fresh as aggregate `findings` on every
// buildSchedule() run and are never persisted, so a legacy row's stamps are
// stale by construction — stripped here, not re-derived (the adapter only
// sees one row, not the whole-template context a fresh finding needs).
// UNFILLABLE and its _reason/_dismissed siblings pass through unchanged.
const STALE_FLAG_KEYS = new Set([
  'UNDERSERVED', 'UNDERSERVED_reason', 'UNDERSERVED_dismissed',
  'DISTRIBUTION', 'DISTRIBUTION_reason', 'DISTRIBUTION_dismissed',
  'WEATHER_RISK', 'WEATHER_RISK_reason', 'WEATHER_RISK_dismissed',
  // OVERLAP is derived at render time from the slots on screen
  // (src/utils/computeOverlaps.js) so it clears from every participating cell
  // the instant any one of them moves. A persisted copy could only ever go
  // stale, so any that reaches the db is dropped on read.
  'OVERLAP', 'OVERLAP_reason', 'OVERLAP_dismissed',
])

// `flags` crosses the LAN op-log sync boundary as JSON.parse'd input, so a
// peer device can plant an own-enumerable "__proto__" key (JSON.parse does
// not treat it specially). Object.create(null) means the assignment below
// can never reach the real Object.prototype — a spoofed "__proto__" key just
// becomes an inert own property named "__proto__" instead of swapping next's
// prototype.
function stripStaleFlags(flags) {
  const next = Object.create(null)
  for (const [k, v] of Object.entries(flags || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    if (!STALE_FLAG_KEYS.has(k)) next[k] = v
  }
  return next
}

export function normalizeSlots(rows) {
  return (rows || []).map(row => {
    const booleans = {
      is_anchor: toSlotBool(row.is_anchor),
      is_span_head: toSlotBool(row.is_span_head),
      is_released: toSlotBool(row.is_released),
    }
    if (typeof row.flags !== 'string') return { ...row, ...booleans, flags: stripStaleFlags(row.flags || {}) }
    try {
      return { ...row, ...booleans, flags: row.flags ? stripStaleFlags(JSON.parse(row.flags)) : {} }
    } catch {
      return { ...row, ...booleans, flags: {} }
    }
  })
}
