// T198 — the ONE assembly of an elective run's projection input for a machine-access caller (the
// MCP `get_elective_assignment_run`/`export_elective_assignments` tools, and `electives.js export`).
// This exists so those two surfaces cannot re-derive the projection input a third way and drift from
// each other or from the UI (docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md,
// MEDIUM-4's "one fragment every reader must use" reasoning, applied one layer up: one ASSEMBLY every
// machine-access reader must use). It calls the SAME ops functions the UI's IPC handlers call
// (getElectiveRun, getElectiveRunOuterSchedule) and the SAME camp-scoped read the renderer's `list()`
// uses (listEntities) — never a second copy of their SQL.
//
// Shape is pinned to what electron/electiveAcceptanceSurfaces.integration.test.jsx's beforeAll
// already assembled by hand (and had proven correct against raw SQL before this module existed):
// { run, campers, groups, days, timeBlocks, outerRows, preferences, assignments, occurrences,
//   staleCount, capacityRows }. `days` maps `label` onto `name` because the export builders
// (exportChildSchedule.js et al.) read `.name`, not `.label`.
//
// T320 round 2, F2 — `run` also carries snapshotIncomplete/expectedSnapshotRows/
// heldSnapshotRows, and `input` carries eligibilityFindings/resourceConflicts, all sourced from
// the SAME `getElectiveRun` call below (never re-derived). Without this, buildElectiveRunProjectionExport's
// `run?.status === 'final' && run?.snapshotIncomplete` refusal was unreachable from the MCP tools
// (scripts/mcp/tools.js) and the CLI (scripts/electivesCli.js) — the one place those two
// machine-access surfaces get a run's completeness is this module, so leaving the fields off here
// meant a partially-synced finalized run exported a complete-looking document on both of them.
import { listEntities } from './read.js'
import { getElectiveRun } from './getElectiveRun.js'
import { getElectiveRunOuterSchedule } from './getElectiveRunOuterSchedule.js'

export function buildElectiveRunProjectionInput(db, { runId }) {
  const run = db
    .prepare('SELECT id, name, status, solver_generation, source_sha256 FROM elective_assignment_runs WHERE id = ?')
    .get(runId)
  if (!run) return { ok: false, error: 'RUN_NOT_FOUND' }

  const ui = getElectiveRun(db, { runId })
  const outer = getElectiveRunOuterSchedule(db, { runId })

  return {
    ok: true,
    input: {
      run: {
        ...run,
        snapshotIncomplete: ui.snapshotIncomplete,
        expectedSnapshotRows: ui.expectedSnapshotRows,
        heldSnapshotRows: ui.heldSnapshotRows,
      },
      campers: listEntities(db, 'campers'),
      groups: listEntities(db, 'groups'),
      days: listEntities(db, 'days_of_operation').map((d) => ({ ...d, name: d.label })),
      timeBlocks: listEntities(db, 'time_blocks'),
      outerRows: outer.rows,
      preferences: ui.preferences,
      assignments: ui.rows,
      occurrences: ui.occurrences,
      offeringOccurrencesByChoiceId: ui.offeringOccurrencesByChoiceId,
      staleCount: ui.staleCount,
      capacityRows: ui.overCapacityOccurrences,
      eligibilityFindings: ui.eligibilityFindings,
      resourceConflicts: ui.resourceConflicts,
    },
  }
}
