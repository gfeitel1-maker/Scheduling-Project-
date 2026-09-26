// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md, Governor
// ruling on Open Question 3): ONE combined projection document, format_version: 1 — because T197's
// premise is "all generated from ONE assignment run so they cannot disagree," and the exit clause
// "roster counts equal summary counts" belongs inside one document. Bundles the four independently-
// testable builders (child schedule, activity roster, exceptions, summary) without re-deriving
// anything — every section is computed from the same already-loaded run data passed in here.
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
  generatedAt = new Date().toISOString(),
} = {}) {
  return {
    format_version: 1,
    generated_at: generatedAt,
    child_schedules: buildChildScheduleExport({ run, campers, groups, days, timeBlocks, outerRows, generatedAt }),
    activity_rosters: buildActivityRosterExport({ run, campers, groups, days, timeBlocks, outerRows, capacityRows, occurrences }),
    exceptions: buildRunExceptionsExport({ campers, preferences, assignments, occurrences, staleCount, capacityRows }),
    summary: buildRunSummaryExport({ run, assignments, preferences, capacityRows }),
  }
}
