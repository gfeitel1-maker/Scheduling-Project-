// T108 Phase 2 review round 3 (Red Hat, HIGH — re-authoring an existing
// override silently no-ops / data loss). day_overrides has
// UNIQUE(schedule_week_id, day_id, group_id, time_block_id) — see
// electron/db/schema.sql and electron/ops/dayOverrides.projections.test.js
// for the real-schema proof. Every write path that authors an override for a
// coordinate MUST reuse that coordinate's EXISTING row id when one already
// exists, never mint a fresh id — a fresh id for an already-overridden
// coordinate silently fails to persist (INSERT OR IGNORE collides on the
// UNIQUE constraint, and the follow-up UPDATE WHERE id=<fresh id> matches
// nothing). One shared pair of helpers so all three call sites (replaceSlot,
// placeActivityManual, pullOverrideCell) can't drift into re-introducing this
// bug independently.

// Finds the existing day_overrides row (if any) for this exact coordinate,
// returning its id, or null when none exists yet (mint a fresh id in that
// case — the normal "authoring a new override" path).
export function findOverrideId(dayOverrides, { weekId, dayId, groupId, blockId }) {
  const existing = (dayOverrides || []).find(
    (o) => o.schedule_week_id === weekId && o.day_id === dayId && o.group_id === groupId && o.time_block_id === blockId
  )
  return existing ? existing.id : null
}

// Upserts `entry` into `prev` (the in-memory dayOverrides array) BY
// COORDINATE, not by id — so a re-authored override REPLACES the stale
// entry in place rather than appending a second one. applyDayOverrides.js's
// `.find(...)` (first match wins) would otherwise keep serving the stale
// first entry even within the same render, on top of the DB-level loss this
// exists to prevent.
export function upsertDayOverride(prev, entry) {
  const list = prev || []
  const idx = list.findIndex(
    (o) => o.schedule_week_id === entry.schedule_week_id && o.day_id === entry.day_id
      && o.group_id === entry.group_id && o.time_block_id === entry.time_block_id
  )
  if (idx === -1) return [...list, entry]
  const next = [...list]
  next[idx] = entry
  return next
}
