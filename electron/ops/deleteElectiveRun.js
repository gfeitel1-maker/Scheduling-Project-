import { appendOp, DELETE_FIELD, runAtomic } from './operations.js'

// T250 A4 — permanently delete an elective run and every row scoped to it, in
// one transaction, children before parent, every delete routed through the
// op-log so it replicates and is auditable — same cascade discipline as
// deleteElectiveSet.js.
//
// A DEDICATED cascade, not a generic delete on the parent row: the six child
// tables declare `run_id TEXT NOT NULL` with no `REFERENCES`, so a parent-only
// delete does not fail — it silently ORPHANS rows holding camper_id
// (elective_preferences, elective_assignments, elective_run_outer_snapshots),
// none of which are in RESTORABLE_ENTITIES, so they would be invisible to
// Trash and unreachable by any screen. That is a worse outcome than no Delete
// control at all.
//
// Cascade order — load-bearing, do not reorder:
//   1. elective_run_outer_snapshots  (run_id)
//   2. elective_assignments          (run_id)
//   3. elective_preferences          (run_id)
//   4. elective_choice_offerings     (choice_id, resolved via elective_choices
//                                      this run holds — it has no run_id of
//                                      its own)
//   5. elective_choices              (run_id)
//   6. elective_occurrences          (run_id)
//   7. elective_assignment_runs      (the parent row itself, last)
//
// A final run is deletable — D10 (ADR 2026-09-23) rules on editing an
// immutable run's CONTENT, not on removing the run itself.
//
// Returns { ok: true, ops } for the caller to broadcast after commit and to
// report ops_written from, or { error: 'not-found' } for a missing/malformed
// runId (retrying after a successful delete is therefore safe).
export function deleteElectiveRun(db, { runId }, { author_user_id, device_id } = {}) {
  if (typeof runId !== 'string' || !runId) return { error: 'not-found' }

  if (!db.prepare('SELECT 1 FROM elective_assignment_runs WHERE id = ?').get(runId)) {
    return { error: 'not-found' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = runAtomic(db, () => {
    const ops = []

    const snapshots = db.prepare('SELECT id FROM elective_run_outer_snapshots WHERE run_id = ?').all(runId)
    for (const s of snapshots) ops.push(del('elective_run_outer_snapshots', s.id))

    const assignments = db.prepare('SELECT id FROM elective_assignments WHERE run_id = ?').all(runId)
    for (const a of assignments) ops.push(del('elective_assignments', a.id))

    const preferences = db.prepare('SELECT id FROM elective_preferences WHERE run_id = ?').all(runId)
    for (const p of preferences) ops.push(del('elective_preferences', p.id))

    const choices = db.prepare('SELECT id FROM elective_choices WHERE run_id = ?').all(runId)
    for (const c of choices) {
      const offerings = db.prepare('SELECT id FROM elective_choice_offerings WHERE choice_id = ?').all(c.id)
      for (const o of offerings) ops.push(del('elective_choice_offerings', o.id))
    }
    for (const c of choices) ops.push(del('elective_choices', c.id))

    const occurrences = db.prepare('SELECT id FROM elective_occurrences WHERE run_id = ?').all(runId)
    for (const o of occurrences) ops.push(del('elective_occurrences', o.id))

    ops.push(del('elective_assignment_runs', runId))

    return { ok: true, ops }
  })

  return outcome
}
