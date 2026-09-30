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
