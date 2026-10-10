// T319 — the ONE name for an elective_assignment_runs row, shared by every
// caller that commits one: the CLI/MCP door (scripts/preferenceSheetCli.js),
// the director's panel (src/screens/elective/assignment/AssignmentPanel.jsx)
// and the browser dev mock (src/localClient.mock.js).
//
// WHY A FILENAME IS THE WRONG FACT. The run id is content-derived
// (deriveImportedElectiveRunId) so that two byte-identical arrivals converge
// onto one row — but a filename is a property of ONE arrival, not of the run
// that may collect more than one. Naming the run after whichever file arrived
// last makes the run's own label a specific, confident, false statement (see
// docs/work/tickets/T319-a-run-is-named-after-the-import-event.md). The run is
// an IMPORT EVENT: when it happened, and how many preference sheets it read.
// That is true on first creation and stays true regardless of which filename
// (or how many) later arrive under the same content-derived id.
//
// Dependency-free on purpose (no imports at all) so it can be imported from
// the renderer, from a plain Node script, and from the dev mock alike without
// dragging any of those environments' assumptions into the other two.
//
// Red Hat round 2, LOW — this string is STAMPED ONCE, at first creation, from
// the creating device's own local clock, and never recomputed: every device
// that later renders this run shows the stored string verbatim, which is WHY
// a viewer in a different timezone sees the same label the importing device
// saw (deliberate — a run's name should not shift depending on who is
// looking at it). The cost of that is the mirror case: a machine whose system
// clock or timezone is wrong writes a label nothing can later correct, not
// even a retry from a device with a correct clock, because a retry on the
// same content-derived run id is suppressed by commitElectiveRun's
// first-creation-only guard (see the comment above `existingRun` there).
//
// Also worth naming since it changed silently: the panel's PREVIOUS name used
// `new Date().toISOString().slice(0, 10)` — a UTC date — and this uses LOCAL
// date/time. A commit made near local midnight can therefore now show a
// different CALENDAR date than the old format would have shown for the same
// wall-clock moment.

/**
 * @param {{ at: Date, sheetCount: number }} args
 *   `at` — when the import happened; formatted in LOCAL time to the minute.
 *   `camperCount` — how many campers this import read (`parsed.campers.length`),
 *   not how many files were selected. Audit E7 (2026-10-10): the count IS campers,
 *   so the name says "campers" — "100 sheets" read as 100 files.
 * @returns {string} e.g. "Import 2026-09-29 14:02, 32 campers"
 */
export function importEventRunName({ at, camperCount }) {
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const noun = camperCount === 1 ? 'camper' : 'campers'
  return `Import ${date} ${time}, ${camperCount} ${noun}`
}
