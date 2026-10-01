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
//   1. elective_run_findings         (run_id)
//   2. elective_run_outer_snapshots  (run_id)
//   3. elective_assignments          (run_id)
//   4. elective_preferences          (run_id)
//   5. elective_choice_offerings     (choice_id, resolved via elective_choices
//                                      this run holds — it has no run_id of
//                                      its own)
//   6. elective_choices              (run_id)
//   7. elective_occurrences          (run_id)
//   8. elective_assignment_runs      (the parent row itself, last)
//
// A final run is deletable — D10 (ADR 2026-09-23) rules on editing an
// immutable run's CONTENT, not on removing the run itself.
//
// Returns { ok: true, ops } for the caller to broadcast after commit and to
// report ops_written from, or { error: 'not-found' } for a missing/malformed
// runId (retrying after a successful delete is therefore safe).
//
// RESURRECTION AFTER A DELETE — what is now true (T320 part 2 item 1,
// docs/adr/2026-09-30-elective-run-durability.md). The Round 2 FIX 2 note this
// block replaces named the wrong path: it said a CONCURRENT PEER WRITE
// resurrects a deleted run. It does not. `projectAll`
// (electron/automerge/projector.js) is two-phase — every entity's upserts in
// forward MODELED_ORDER, then every entity's delete-reconcile in REVERSE — and
// elective_assignment_runs precedes all of its children in
// DOMAIN_SNAPSHOT_ORDER, so the parent is reconciled LAST and any stub ghost a
// child's ensureExists seeded during the upsert phase is deleted again in the
// same pass. Every merge projects through it (syncNode.js). Confirmed by
// execution, not by reading: after merging a peer's racing child write the
// runs table is empty and the orphan child survives, which is correct
// convergence for a document that holds the child and not the parent.
//
// The path that really did resurrect is the SAME-DEVICE appendOp path, which
// calls applyProjection directly and runs no projectAll. That is now guarded:
// ensureParentStub (electron/ops/projections.js) refuses to seed a parent whose
// LAST recorded op-log act was its own deletion, and elective_assignment_runs
// is in TOMBSTONE_GUARDED_STUB_PARENTS. elective_sets — the same hazard
// deleteElectiveSet.js has carried since schema v35 — is guarded by the same
// function.
//
// THE RESIDUAL, named rather than absorbed: a peer with no `devices` row for
// the sender skips the whole received-op batch (appendReceivedOps,
// electron/automerge/historyLedger.js, which states why inventing a row would
// be worse), so no `__deleted__` op row exists there and a later LOCAL child
// write can still seed a ghost. Bounded by the two-phase self-healing above:
// the next merge-triggered projectAll removes it. DeleteRunDialog's cost copy
// (src/screens/elective/run/DeleteRunDialog.jsx, DELETE_RUN_COST_COPY) still
// names the possibility rather than promising a completeness the code cannot
// back.
export function deleteElectiveRun(db, { runId }, { author_user_id, device_id } = {}) {
  if (typeof runId !== 'string' || !runId) return { error: 'not-found' }

  if (!db.prepare('SELECT 1 FROM elective_assignment_runs WHERE id = ?').get(runId)) {
    return { error: 'not-found' }
  }

  const del = (entity, entity_id) =>
    appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id, device_id })

  const outcome = runAtomic(db, () => {
    const ops = []

    // T320 part 2 item 3 — these rows now carry a real `camper_id`, so an
    // orphan is orphaned PII, not just a stray diagnostic.
    const runFindings = db.prepare('SELECT id FROM elective_run_findings WHERE run_id = ?').all(runId)
    for (const f of runFindings) ops.push(del('elective_run_findings', f.id))

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
