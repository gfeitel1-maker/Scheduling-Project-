// The IPC SEAM, and the only seam a jsdom test can stand at.
//
// T251. docs/work/tickets/T251-t199-acceptance-fixture.md.
//
// WHY THIS EXISTS AT ALL. §6's conditions about the solve — capacity,
// eligibility, locks, the linked choice — are conditions about a composition
// that no production module performs: `deriveOccurrences` -> `buildOfferings` ->
// `deriveChoices` -> `resolvePreferenceCoordinates` -> `buildAttendance` ->
// `buildElectiveAssignments` -> `commitElectiveRun` exists only inside a React
// callback (`solve()` at
// src/screens/elective/assignment/AssignmentPanel.jsx:611-700).
// `runPreferenceSheetCli` commits `assignments: []`
// (scripts/preferenceSheetCli.js:355-379) and the IPC handler takes an
// already-solved array (electron/main.js:2070-2098). Re-implementing that
// composition in a test would assert that a test agrees with itself, which is
// the T62 defect shape (see electron/fixtures/electiveAcceptanceCamp.js's
// header). So the real component is rendered and driven.
//
// WHAT THIS IS NOT. It is NOT src/localClient.mock.js. That module is a
// browser-dev substitute with no schema behind it — it prunes
// `elective_occurrences` by `run_id` where production never deletes one, and
// its `finalizeElectiveRun` never writes `finalized_by`. Nothing here decides
// anything: every method forwards to the REAL IPC handler from
// `makeHandlers`, over a REAL better-sqlite3 database through the full
// migration chain. The renderer never touches SQLite (CLAUDE.md), so this
// forwarding IS the boundary, not a stand-in for it.
//
// Precedent for standing here: src/screens/elective/run/
// camperWeekFromDatabase.test.jsx:9-45 and
// src/screens/elective/run/preferenceEditToResolve.test.jsx, both of which stub
// localClient in front of real ops over a real database file. What is new is
// binding the stub to `makeHandlers` rather than to individual ops, so the
// AUTHORIZATION and the handler-level argument marshalling are real too.

/**
 * @param {object} handlers  the return of makeHandlers(db, deviceId, {})
 * @param {string} token     a real token from handlers.login
 */
export function makeLocalClientOverHandlers(handlers, token) {
  return {
    // Reads.
    list: (entity) => handlers.list(token, entity),
    listByScope: (entity, scopeId) => handlers.listByScope(token, entity, scopeId),
    listElectiveRuns: () => handlers.listElectiveRuns(token),
    getElectiveRun: ({ runId }) => handlers.getElectiveRun({ token, runId }),
    getElectiveRunOuterSchedule: ({ runId }) => handlers.getElectiveRunOuterSchedule({ token, runId }),
    // Deliberately the REAL read and not a `true`: AssignmentPanel's encryption
    // disclosure fails closed, and hard-coding it would hide a render branch.
    getSecurityStatus: () => handlers.getSecurityStatus(),

    // Writes.
    write: (tok, entity, entity_id, field, value) =>
      handlers.write({ token, entity, entity_id, field, value }),
    // A delete is a write of the '__deleted__' sentinel, exactly as
    // src/localClient.js:94-95 does it — there is no deleteEntity handler.
    deleteEntity: (tok, entity, entity_id) =>
      handlers.write({ token, entity, entity_id, field: '__deleted__', value: 1 }),
    bulkReplace: (tok, entity, scope_id, rows) => handlers.bulkReplace({ token, entity, scope_id, rows }),
    commitElectiveRun: (args) => handlers.commitElectiveRun({ token, ...args }),
    finalizeElectiveRun: ({ runId }) => handlers.finalizeElectiveRun({ token, runId }),
    setElectiveAssignment: (args) => handlers.setElectiveAssignment({ token, ...args }),
    setElectivePreference: (args) => handlers.setElectivePreference({ token, ...args }),
    removeElectivePreference: (args) => handlers.removeElectivePreference({ token, ...args }),

    // Best-effort diagnostics the panel never blocks on. Forwarded, not
    // no-op'd, so a throw from one of them would still surface.
    recordImportDecisions: (args) => handlers.recordImportDecisions({ token, ...args }),
    rememberColumnMapping: (args) => handlers.rememberColumnMapping({ token, ...args }),
  }
}
