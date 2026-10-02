// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md, Governor
// ruling on Open Question 3): ONE combined projection document — because T197's
// premise is "all generated from ONE assignment run so they cannot disagree," and the exit clause
// "roster counts equal summary counts" belongs inside one document. Bundles the four independently-
// testable builders (child schedule, activity roster, exceptions, summary) without re-deriving
// anything — every section is computed from the same already-loaded run data passed in here.
//
// T318 (c4) bumped format_version 1 -> 2: `summary` gained `unordered_count`,
// which buildRunSummaryExport needs `days`/`timeBlocks` to compute (occurrences
// was already threaded through for the roster). Precedented — exportChildSchedule.js
// bumped 1 -> 2 for its own added-field change, no ADR required for either.
//
// T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) bumps
// format_version 2 -> 3: the JSON SHAPE of exceptions.eligibility/.resource
// does not change, but their MEANING does — before, an empty array meant
// "not computed"; after, it means "computed, zero findings." A consumer that
// branched on not_computed before this change and stops checking it now
// would silently misinterpret an old cached export against a new empty
// result, or vice versa — exactly the silent-semantic-drift format_version
// exists to flag even when the wire shape is byte-identical.
//
// T320 item 1 also adds a hard REFUSAL, additive to what was previously an
// always-succeeding pure function: a final run whose outer snapshot is
// incomplete (run.snapshotIncomplete, from getElectiveRun.js /
// getElectiveRunOuterSchedule.js) refuses rather than emitting a
// complete-looking document with holes. Every caller must check `.ok` before
// treating the result as a document.
import { buildChildScheduleExport } from './exportChildSchedule.js'
import { buildActivityRosterExport } from './exportActivityRoster.js'
import { buildRunExceptionsExport } from './exportRunExceptions.js'
import { buildRunSummaryExport } from './exportRunSummary.js'

export function buildElectiveRunProjectionExport({
  run,
  campers = [],
  groups = [],
  days = [],
  timeBlocks = [],
  outerRows = [],
  preferences = [],
  assignments = [],
  occurrences = [],
  staleCount = 0,
  capacityRows = [],
  eligibilityFindings = [],
  resourceConflicts = [],
  offeringOccurrencesByChoiceId = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  if (run?.status === 'final' && run?.snapshotIncomplete) {
    return {
      ok: false,
      error: 'SNAPSHOT_INCOMPLETE',
      expectedSnapshotRows: run.expectedSnapshotRows,
      heldSnapshotRows: run.heldSnapshotRows,
    }
  }
  return {
    format_version: 3,
    generated_at: generatedAt,
    child_schedules: buildChildScheduleExport({ run, campers, groups, days, timeBlocks, outerRows, generatedAt }),
    activity_rosters: buildActivityRosterExport({ run, campers, groups, days, timeBlocks, outerRows, capacityRows, occurrences }),
    exceptions: buildRunExceptionsExport({
      campers, preferences, assignments, occurrences, staleCount, capacityRows, eligibilityFindings, resourceConflicts,
    }),
    summary: buildRunSummaryExport({
      run, assignments, preferences, capacityRows, occurrences, days, timeBlocks, offeringOccurrencesByChoiceId,
    }),
  }
}
