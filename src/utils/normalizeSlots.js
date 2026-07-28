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

export function normalizeSlots(rows) {
  return (rows || []).map(row => {
    const booleans = {
      is_anchor: toSlotBool(row.is_anchor),
      is_span_head: toSlotBool(row.is_span_head),
      is_released: toSlotBool(row.is_released),
    }
    if (typeof row.flags !== 'string') return { ...row, ...booleans, flags: row.flags || {} }
    try {
      return { ...row, ...booleans, flags: row.flags ? JSON.parse(row.flags) : {} }
    } catch {
      return { ...row, ...booleans, flags: {} }
    }
  })
}
