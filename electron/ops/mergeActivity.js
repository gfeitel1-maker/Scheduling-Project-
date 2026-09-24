// Merge one activity into another, re-pointing everything that referenced it.
//
// WHY THIS EXISTS. A re-imported schedule with a typo'd activity name silently
// CREATES a second activity: renaming "Music" to "Musik" in a file produces a
// new row beside the old one, and the reconciler asks nothing, because it
// classifies the import as fully understood (evidence:
// docs/work/evidence/2026-09-15-real-import-journal-probe.md). The camp ends up
// with two activities where it had one and nobody is told.
//
// The answer is the Locations posture, not a new import-time question:
// CONSTITUTION Art. V — FLAG, NEVER BLOCK. The screen shows a quiet derived
// marker; this is the merge behind its one-click fix.
//
// THE REFERRER SWEEP IS THE WHOLE RISK. Locations shipped handling two of six
// referrer kinds and silently orphaned the other four. Activities are harder:
//
//   - THREE of the five activity_id columns carry NO foreign key, by their own
//     schema's deliberate design (special_day_slots, elective_set_activities,
//     event_slots). Forgetting one raises no error of any kind — the schedule
//     simply points at an activity that no longer exists.
//   - `activities.weather_alternative_id` makes an activity a referrer of
//     another activity. A grep for `activity_id` never finds it; it was found
//     by reading PRAGMA table_info instead, and only after the first sweep had
//     already missed it.
//
// Every write goes through appendOp, so the authoritative Automerge document
// learns about the merge. Editing SQLite directly would be undone by the next
// projectAll — SQLite is the projection, not the truth.
import { appendOp, DELETE_FIELD, runAtomic } from './operations.js'

// Each entry is a table that stores an activity id, and how a merge treats it.
// Kept as data rather than six near-identical code blocks so that adding a
// seventh referrer is one line — and so this list can be read against
// PRAGMA table_info by a test rather than trusted.
const ACTIVITY_REFERRERS = Object.freeze([
  { entity: 'template_slots', field: 'activity_id' },
  { entity: 'week_activity_exclusions', field: 'activity_id' },
  { entity: 'special_day_slots', field: 'activity_id' },   // no FK
  { entity: 'event_slots', field: 'activity_id' },         // no FK
  // T194 (v66), both soft references with no FK. A merge MUST re-point these
  // or an assignment and the offering it came from are silently stranded on the
  // losing activity — a child's schedule quietly pointing at an activity the
  // director just merged away. Found by this file's own PRAGMA-driven guard,
  // which is exactly what that guard exists for.
  { entity: 'elective_choice_offerings', field: 'activity_id' },  // no FK
  { entity: 'elective_assignments', field: 'activity_id' },       // no FK
  // T243 (v74). Re-pointing activity_id keeps it a resolvable reference to a
  // live activity rather than a dangling id the merge just deleted from
  // underneath it. This does NOT touch activity_name — that field is
  // deliberately denormalized (docs/adr/2026-09-23-elective-run-lifecycle-and-
  // remaining-slices.md, decision (a)) so a finalized run's export stays
  // byte-stable even after the underlying activity is later renamed or
  // deleted. The merge changes what the id points to; it must never change
  // what the frozen snapshot says was actually scheduled.
  { entity: 'elective_run_outer_snapshots', field: 'activity_id' },  // no FK
])

/** Rows pointing at this activity, per referrer table. */
function activityReferenceRows(db, activity_id) {
  const refs = {}
  for (const { entity, field } of ACTIVITY_REFERRERS) {
    refs[entity] = db.prepare(`SELECT id FROM ${entity} WHERE ${field} = ?`).all(activity_id)
  }
  // UNIQUE(elective_set_id, activity_id) means a membership cannot simply be
  // re-pointed when the winner is already an option in the same set — see below.
  refs.elective_set_activities = db
    .prepare('SELECT id, elective_set_id FROM elective_set_activities WHERE activity_id = ?')
    .all(activity_id)
  // The self-reference: activities whose rainy-day alternative is this one.
  refs.weather_alternatives = db
    .prepare('SELECT id FROM activities WHERE weather_alternative_id = ?')
    .all(activity_id)
  return refs
}

/**
 * The single number the director agrees to, re-counted inside the transaction.
 * Everything that would visibly change if the merge goes ahead.
 */
export function totalActivityRefCount(refs) {
  return Object.values(refs).reduce((n, rows) => n + rows.length, 0)
}

/** Read-only: what a confirm dialog should say before the director agrees. */
export function previewActivityMerge(db, { loser_id }) {
  if (!db.prepare('SELECT 1 FROM activities WHERE id = ?').get(loser_id)) return { error: 'no-record' }
  const refs = activityReferenceRows(db, loser_id)
  return { ok: true, ref_count: totalActivityRefCount(refs) }
}

/**
 * Merge `loser_id` into `winner_id`.
 *
 * Order inside the one transaction is fixed and load-bearing, exactly as in
 * mergeLocation: re-point every referrer FIRST, delete the losing activity
 * LAST. The parent delete carries the highest seq and is broadcast last, so a
 * peer applying in order has already re-pointed the children when it arrives
 * and its own `foreign_keys = ON` is satisfied. Deleting first would be
 * silently fine here and silently broken on every peer.
 *
 * @returns {{ok: true, ref_count: number, ops: object[]}|{error: string, ref_count?: number}}
 */
export function mergeActivity(db, { loser_id, winner_id, expected_ref_count, author_user_id = null, device_id = null } = {}) {
  if (typeof loser_id !== 'string' || loser_id.length === 0) return { error: 'no-record' }
  if (typeof winner_id !== 'string' || winner_id.length === 0 || winner_id === loser_id) {
    return { error: 'invalid-winner' }
  }
  if (!db.prepare('SELECT 1 FROM activities WHERE id = ?').get(loser_id)) return { error: 'no-record' }
  if (!db.prepare('SELECT 1 FROM activities WHERE id = ?').get(winner_id)) return { error: 'no-winner' }

  return runAtomic(db, () => {
    const refs = activityReferenceRows(db, loser_id)
    const ref_count = totalActivityRefCount(refs)

    // A peer can add or move a slot between the preview and the confirmation.
    // A count the director did not agree to is not a count.
    if (Number.isInteger(expected_ref_count) && ref_count !== expected_ref_count) {
      return { error: 'count-changed', ref_count }
    }

    const ops = []
    const push = (entity, entity_id, field, value) =>
      ops.push(appendOp(db, { entity, entity_id, field, value, author_user_id, device_id }))

    for (const { entity, field } of ACTIVITY_REFERRERS) {
      for (const row of refs[entity]) push(entity, row.id, field, winner_id)
    }

    // An elective set offering both names was offering one option twice. Where
    // the winner is already a member, the losing membership is REMOVED rather
    // than re-pointed — re-pointing would violate
    // UNIQUE(elective_set_id, activity_id) and throw midway through a merge
    // that has already re-pointed other referrers.
    for (const row of refs.elective_set_activities) {
      const winnerAlreadyIn = db
        .prepare('SELECT 1 FROM elective_set_activities WHERE elective_set_id = ? AND activity_id = ?')
        .get(row.elective_set_id, winner_id)
      if (winnerAlreadyIn) push('elective_set_activities', row.id, DELETE_FIELD, 1)
      else push('elective_set_activities', row.id, 'activity_id', winner_id)
    }

    // Re-point rainy-day alternatives — except the winner's own, which would
    // otherwise end up naming itself as its own alternative. That is not a
    // fallback, so it is cleared instead.
    for (const row of refs.weather_alternatives) {
      if (row.id === winner_id) push('activities', row.id, 'weather_alternative_id', null)
      else push('activities', row.id, 'weather_alternative_id', winner_id)
    }

    push('activities', loser_id, DELETE_FIELD, 1)

    return { ok: true, ref_count, ops }
  })
}

export const ACTIVITY_REFERRER_TABLES = Object.freeze(
  ACTIVITY_REFERRERS.map((r) => r.entity).concat(['elective_set_activities', 'activities'])
)
