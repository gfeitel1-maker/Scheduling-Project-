// T195 — preview half of the preference import service.
//
// READ-ONLY by construction: every db access here is a SELECT that builds a
// snapshot, then the pure resolver (src/ingest/preferenceImport/resolve.js)
// runs against those snapshots. This function must NEVER open a transaction,
// call appendOp/runAtomic, or execute any INSERT/UPDATE/DELETE — that
// invariant is asserted by preferenceImportPreview.test.js via a db.prepare
// spy AND a live before/after row-count snapshot (two independent
// mechanisms, per the T195 success predicate).
//
// Occurrence derivation (G1, ADR D6): this slice derives a run's occurrence
// set from `elective_sets` in scope for the run's schedule_week_id (or a
// reusable set with no week) — each set contributes one occurrence per
// (day_id, time_block_id), tiered by the run's own tier_id. That is the
// run's frozen premise; commitPreferenceImport writes exactly this same set.
import { deriveElectiveOccurrenceId } from './electiveDerivedIds.js'
import { resolvePreferenceImport } from '../../src/ingest/preferenceImport/resolve.js'

const NO_TIER = 'no-tier'

function loadRun(db, run_id) {
  return db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(run_id) ?? null
}

function findDuplicateRun(db, camp_id, source_sha256) {
  if (!source_sha256) return null
  return (
    db
      .prepare(
        'SELECT id FROM elective_assignment_runs WHERE camp_id = ? AND source_sha256 = ?'
      )
      .get(camp_id, source_sha256) ?? null
  )
}

/**
 * Builds { occurrences, activityIndex, offeringIndex } from the live
 * elective-set configuration in scope for this run — read-only.
 */
export function loadRunSnapshot(db, { camp_id, run_id }) {
  const run = loadRun(db, run_id)
  const tierId = run?.tier_id || NO_TIER

  const sets = db
    .prepare(
      `SELECT id, day_id, time_block_id FROM elective_sets
       WHERE camp_id = ? AND (schedule_week_id = ? OR (schedule_week_id IS NULL AND is_reusable = 1))`
    )
    .all(camp_id, run?.schedule_week_id ?? null)

  const occurrences = []
  const offeringIndex = {}
  for (const set of sets) {
    const occurrenceId = deriveElectiveOccurrenceId(run_id, set.id, set.day_id || 'no-day', set.time_block_id || 'no-block', tierId)
    occurrences.push({ id: occurrenceId, elective_set_id: set.id, day_id: set.day_id, time_block_id: set.time_block_id, tier_id: tierId })
    const members = db
      .prepare('SELECT activity_id FROM elective_set_activities WHERE elective_set_id = ?')
      .all(set.id)
    for (const { activity_id } of members) {
      offeringIndex[activity_id] = offeringIndex[activity_id] ?? []
      offeringIndex[activity_id].push(occurrenceId)
    }
  }

  const activityRows = db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(camp_id)
  const activityIndex = {}
  for (const { id, name } of activityRows) {
    activityIndex[name] = activityIndex[name] ?? []
    activityIndex[name].push(id)
  }

  const roster = db
    .prepare('SELECT id, display_name, group_id, external_id, is_active FROM campers WHERE camp_id = ?')
    .all(camp_id)
    .map((c) => ({ ...c, createdAt: earliestOpTimestamp(db, 'campers', c.id) }))

  const groups = db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(camp_id)

  return { run, occurrences, offeringIndex, activityIndex, roster, groups }
}

function earliestOpTimestamp(db, entity, entity_id) {
  const row = db
    .prepare('SELECT timestamp FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC LIMIT 1')
    .get(entity, entity_id)
  return row ? row.timestamp : null
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function previewPreferenceImport(db, { camp_id, run_id, headers, rows, mapping, source_sha256 }) {
  const duplicate = findDuplicateRun(db, camp_id, source_sha256)
  if (duplicate) {
    return { duplicate: true, existingRunId: duplicate.id }
  }

  const { occurrences, offeringIndex, activityIndex, roster, groups } = loadRunSnapshot(db, { camp_id, run_id })

  return resolvePreferenceImport({
    rows,
    headers,
    mapping,
    roster,
    groups,
    occurrenceIndex: occurrences,
    offeringIndex,
    activityIndex,
  })
}
