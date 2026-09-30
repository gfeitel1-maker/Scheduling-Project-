// T320 round 2, F4 (Red Hat) — the shared "occurrence is USABLE" predicate
// getElectiveRun.js's durable dangling query needs, so it and any future
// reader define "still exists" identically. A bare row-existence check
// (`NOT EXISTS (SELECT 1 FROM elective_occurrences WHERE id = ...)`) is
// unsound: `elective_occurrences`' stub-seed (`ensureExists` in
// electron/ops/projections.js) inserts a row from `run_id` ALONE on the
// first field to arrive — unlike its siblings `elective_bundles`/
// `elective_set_activities`, it does NOT wait for `day_id`/`time_block_id`
// before existing. During a partial merge, that stub row (id + run_id only,
// day/time_block still NULL) makes a bare EXISTS check see the occurrence as
// "present" and silently clear the DANGLING_MANUAL_ASSIGNMENT finding while
// the placement is still unrenderable — a false all-clear, the exact failure
// mode item 1's snapshot digest exists to catch, left unguarded one item
// over. Requiring day_id/time_block_id to be non-null closes that without
// touching `ensureExists` itself, which is the shared stub-seed choke point
// — out of this ticket's scope and gated on its own ADR.
export function danglingOccurrenceMissingOrUnusableFragment(assignmentAlias = 'a') {
  return `NOT EXISTS (
    SELECT 1 FROM elective_occurrences o
     WHERE o.id = ${assignmentAlias}.occurrence_id
       AND o.day_id IS NOT NULL AND o.time_block_id IS NOT NULL
  )`
}

// The DANGLING_MANUAL_ASSIGNMENT finding shape and message, shared by
// commitElectiveRun.js (session-scoped, at commit time) and getElectiveRun.js
// (durable, at read time) — T320, docs/adr/2026-09-30-elective-run-
// durability.md item 2. One fragment, no second copy, so wording cannot
// drift between the two call sites (DraftRunView.jsx's own comment already
// flagged this as a past regression risk).
export function buildDanglingManualAssignmentFinding(row) {
  return {
    kind: 'DANGLING_MANUAL_ASSIGNMENT',
    assignment_id: row.id,
    camper_id: row.camper_id,
    occurrence_id: row.occurrence_id,
    message:
      'A placement made by hand sits in a period this schedule no longer has, so nobody will see ' +
      'it on the grid — move it to a period that still exists, or remove it.',
  }
}
