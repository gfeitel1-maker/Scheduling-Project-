// declinedSplits — the single writer/reader of declined_two_row_splits (Slice
// 2a, host-local). Mirrors confirmAlias.js's shape: a direct, transactional
// SQL write with NO appendOp call — declined_two_row_splits is never
// replicated and never replayed, same as source_aliases.
//
// docs/adr/2026-08-23-two-rows-multipattern-split.md
// docs/work/specs/2026-08-23-two-rows-slice2-affordance.md "Decline-memory"
//
// Names are stored NORMALIZED (normalizeName from src/ingest/preview.js — the
// same helper emitTwoRowSplit and dualUseNames use). Callers pass the raw
// activity name; this module normalizes it, so the read side (listDeclined-
// SplitNames) always matches what the write side stored.

import { randomUUID } from 'node:crypto'
import { normalizeName } from '../../src/ingest/preview.js'

/**
 * Record that the director declined a two-rows split suggestion for
 * `activityName`. Idempotent — declining twice is a no-op (INSERT OR IGNORE
 * against UNIQUE(camp_id, activity_name_normalized)).
 */
export function recordDeclinedSplit(db, { campId, activityName }) {
  if (!campId) throw new Error('recordDeclinedSplit: campId is required')
  const normalized = normalizeName(activityName)
  if (!normalized) throw new Error('recordDeclinedSplit: activityName is required')

  db.prepare(
    `INSERT OR IGNORE INTO declined_two_row_splits (id, camp_id, activity_name_normalized, declined_at)
     VALUES (?, ?, ?, ?)`
  ).run(randomUUID(), campId, normalized, new Date().toISOString())
}

/**
 * Every activity name the director has declined a split suggestion for, in
 * this camp — normalized, so callers filter dualUseNames (already normalized)
 * against this set directly.
 *
 * @returns {Set<string>}
 */
export function listDeclinedSplitNames(db, { campId }) {
  if (!campId) throw new Error('listDeclinedSplitNames: campId is required')
  const rows = db
    .prepare('SELECT activity_name_normalized FROM declined_two_row_splits WHERE camp_id = ?')
    .all(campId)
  return new Set(rows.map((r) => r.activity_name_normalized))
}
