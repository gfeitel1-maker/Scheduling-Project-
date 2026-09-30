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
//
// HOW FAR "THE AUTHORIZATION IS REAL" GOES, stated rather than implied. Every
// call below reaches `authorize()` with a token this module did not invent:
// it is read from localStorage per call, exactly as src/localClient.js's
// `currentToken()` does, so an expired or cleared session would refuse here as
// it refuses in the app. What no test in this family exercises is a CALLER
// supplying a different token from the session's — measured, seeding
// localStorage with a bogus token changes no result, because the panel's write
// path in these flows goes through the methods that read the session rather
// than through the repositories' `(token, …)` signature.

/**
 * @param {object} handlers  the return of makeHandlers(db, deviceId, {})
 * @param {string} token     a real token from handlers.login
 */
export function makeLocalClientOverHandlers(handlers, token) {
  // THE TOKEN COMES FROM WHERE PRODUCTION GETS IT, not from this closure.
  // src/localClient.js:16-19's `currentToken()` reads
  // `localStorage['shoresh-token']` on every call, and the repositories do the
  // same (src/data/scheduleRepository.js:59). Round 1 bound the token here and
  // dropped the `tok` argument its write/deleteEntity/bulkReplace were handed,
  // so a regression in which the renderer sent a stale, expired or undefined
  // token could not fail any of these tests — while the header below claims
  // the authorization is real.
  //
  // localStorage IS REPLACED RATHER THAN WRITTEN TO, and the reason is
  // measured: in a jsdom file that mocks `electron`, `globalThis.localStorage`
  // is an object with no `setItem` and no `getItem` at all (the same probe
  // without the mock reports a real Storage). The four methods the renderer
  // touches are supplied outright instead of depending on that.
  const store = new Map([['shoresh-token', token]])
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  const sessionToken = () => globalThis.localStorage.getItem('shoresh-token')

  return {
    // Reads.
    list: (entity) => handlers.list(sessionToken(), entity),
    listByScope: (entity, scopeId) => handlers.listByScope(sessionToken(), entity, scopeId),
    listElectiveRuns: () => handlers.listElectiveRuns(sessionToken()),
    getElectiveRun: ({ runId }) => handlers.getElectiveRun({ token: sessionToken(), runId }),
    getElectiveRunOuterSchedule: ({ runId }) => handlers.getElectiveRunOuterSchedule({ token: sessionToken(), runId }),
    // Deliberately the REAL read and not a `true`: AssignmentPanel's encryption
    // disclosure fails closed, and hard-coding it would hide a render branch.
    getSecurityStatus: () => handlers.getSecurityStatus(),

    // Writes. THE CALLER'S TOKEN IS FORWARDED, not swallowed — production
    // (src/localClient.js:86-97) forwards whatever the caller gave it, and the
    // caller is a repository that read it from localStorage. Round 1 dropped
    // `tok` on the floor.
    write: (tok, entity, entity_id, field, value) =>
      handlers.write({ token: tok, entity, entity_id, field, value }),
    // A delete is a write of the '__deleted__' sentinel, exactly as
    // src/localClient.js:94-95 does it — there is no deleteEntity handler.
    deleteEntity: (tok, entity, entity_id) =>
      handlers.write({ token: tok, entity, entity_id, field: '__deleted__', value: 1 }),
    bulkReplace: (tok, entity, scope_id, rows) => handlers.bulkReplace({ token: tok, entity, scope_id, rows }),
    commitElectiveRun: (args) => handlers.commitElectiveRun({ token: sessionToken(), ...args }),
    finalizeElectiveRun: ({ runId }) => handlers.finalizeElectiveRun({ token: sessionToken(), runId }),
    setElectiveAssignment: (args) => handlers.setElectiveAssignment({ token: sessionToken(), ...args }),
    setElectivePreference: (args) => handlers.setElectivePreference({ token: sessionToken(), ...args }),
    removeElectivePreference: (args) => handlers.removeElectivePreference({ token: sessionToken(), ...args }),

    // Best-effort diagnostics the panel never blocks on. Forwarded, not
    // no-op'd, so a throw from one of them would still surface.
    recordImportDecisions: (args) => handlers.recordImportDecisions({ token: sessionToken(), ...args }),
    rememberColumnMapping: (args) => handlers.rememberColumnMapping({ token: sessionToken(), ...args }),
  }
}
