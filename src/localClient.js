// Thin wrapper around window.shoresh (exposed by electron/preload.js).
// In a plain browser dev server (no Electron), window.shoresh is undefined —
// fall back to a mock so screens can still be visually verified with `npm run dev`.
import { mockShoresh } from './localClient.mock'

const shoresh = typeof window !== 'undefined' && window.shoresh ? window.shoresh : mockShoresh

// getCamp/listUsers/list/getDeviceId/listPendingConflicts don't already
// receive a token from their many call sites the way write/bulkReplace/
// resolveConflict do (those take token as an explicit param because callers
// already have it in scope for a write). Reading it here directly — the same
// storage key useDeviceMode.js/every screen already reads via
// `localStorage.getItem('shoresh-token')` — keeps authorize() wiring
// (electron/main.js) from requiring a token-threading change across every
// screen that calls these read-only helpers.
const TOKEN_KEY = 'shoresh-token'
function currentToken() {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null
}

export const localClient = {
  chooseMode: (args) => shoresh.chooseMode(args),
  discoverHosts: () => shoresh.discoverHosts(),
  login: (name, pin) => shoresh.login({ name, pin }),
  createUser: (args) => shoresh.createUser(args),
  bootstrapCamp: (args) => shoresh.bootstrapCamp(args),
  write: (token, entity, entity_id, field, value, parent_op_id) =>
    shoresh.write({ token, entity, entity_id, field, value, ...(parent_op_id ? { parent_op_id } : {}) }),
  // Row delete, routed through the same shoresh.write IPC channel as a field
  // write — see DELETE_FIELD in electron/ops/operations.js. field: '__deleted__'
  // is a reserved sentinel that applyProjection turns into a real DELETE.
  deleteEntity: (token, entity, entity_id) =>
    shoresh.write({ token, entity, entity_id, field: '__deleted__', value: 1 }),
  bulkReplace: (token, entity, scope_id, rows) =>
    shoresh.bulkReplace({ token, entity, scope_id, rows }),
  verifySession: (token) => shoresh.verifySession({ token }),
  // Deploy smoke-test heartbeat — see electron/main.js and App.jsx. Routed
  // through here (not window.shoresh directly) to satisfy the mock-parity
  // invariant; in browser dev it hits the mock's no-op.
  reportSmokeReady: () => shoresh.reportSmokeReady(),
  onOpApplied: (cb) => shoresh.onOpApplied(cb),
  // T27 — is this device the main computer, connected to it, or on its own.
  getSyncStatus: () => shoresh.getSyncStatus(),
  // T16 — commit an approved import proposal. The preview is built in the
  // renderer; only the confirmed list crosses this boundary.
  // One options object rather than six positional arguments: `mode` (T61) is
  // the one that decides whether the camp's existing setup is destroyed, and
  // it must not be reachable by miscounting commas. Fields are enumerated
  // explicitly, never spread, so a caller-supplied token cannot override the
  // real one — same rule as deleteWeek below.
  // U1 (docs/adr/2026-08-17-onescreen-reconciliation-undo.md) — captureInverse
  // is additive and opt-in; every existing caller that omits it is unaffected.
  ingestCommit: ({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, captureInverse } = {}) =>
    shoresh.ingestCommit({ token: currentToken(), approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames, captureInverse }),
  // D1 — read-only dry run of the same commit pipeline, for the reconciliation
  // summary. Same argument shape as ingestCommit; never writes.
  ingestReconcile: ({ approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames } = {}) =>
    shoresh.ingestReconcile({ token: currentToken(), approved, links, clears, humanEditedFields, cohort_id, fixedEvents, activityRules, mode, resolutions, base_generation, seenCounts, pinOnlyActivityNames }),
  // U1+U2 — reverts field-updates AND newly-created rows from a
  // captureInverse commit. See the ADR's "grace-window" mechanism;
  // invertibleOps/createdEntityIds never persist past the renderer session
  // (Invariant 5), so this is the only place they are read from.
  ingestUndo: ({ invertibleOps, createdEntityIds, client_write_id } = {}) =>
    shoresh.ingestUndo({ token: currentToken(), invertibleOps, createdEntityIds, client_write_id }),
  // S1b — remember an import label -> existing entity mapping so the next
  // import recognizes it without re-asking. Host-only, admin-gated at the IPC
  // boundary (electron/main.js's confirmAliasHandler); best-effort by callers.
  confirmAlias: ({ entity_type, cohort_id, source_label, entity_id } = {}) =>
    shoresh.confirmAlias({ token: currentToken(), entity_type, cohort_id, source_label, entity_id }),
  // S4b §4 — the op-log generation S4a's export stamps as base_generation so the
  // round-trip's staleness gate has a real clock. Read-only; 0 on the dev mock.
  latestOpSeq: () => (shoresh.latestOpSeq ? shoresh.latestOpSeq() : Promise.resolve(0)),
  onSyncStatusChanged: (cb) => shoresh.onSyncStatusChanged?.(cb) ?? (() => {}),
  onOpConflict: (cb) => shoresh.onOpConflict(cb),
  // docs/adr/2026-08-15-locations-concurrent-create-collision.md
  onOpRejected: (cb) => shoresh.onOpRejected(cb),
  getCamp: () => shoresh.getCamp(),
  listUsers: () => shoresh.listUsers(currentToken()),
  getDeviceId: () => shoresh.getDeviceId(currentToken()),
  list: (entity) => shoresh.list(currentToken(), entity),
  listByScope: (entity, scopeId) => shoresh.listByScope(currentToken(), entity, scopeId),
  resolveConflict: (token, { entity, entity_id, field, chosen_op_id, parent_op_id }) =>
    shoresh.resolveConflict({ token, entity, entity_id, field, chosen_op_id, parent_op_id }),
  listPendingConflicts: () => shoresh.listPendingConflicts(currentToken()),
  listDeleted: () => shoresh.listDeleted(currentToken()),
  listPendingRestores: () => shoresh.listPendingRestores(currentToken()),
  getEntityHistory: (entity, entity_id) =>
    shoresh.getEntityHistory({ token: currentToken(), entity, entity_id }),
  restoreEntity: (entity, entity_id) =>
    shoresh.restoreEntity({ token: currentToken(), entity, entity_id }),
  // Deleting a record a schedule uses: previewDelete counts what would change
  // so the confirmation can state it, deleteRecord clears it and deletes.
  // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  previewDelete: (entity, entity_id) =>
    shoresh.previewDelete({ token: currentToken(), entity, entity_id }),
  deleteRecord: (entity, entity_id, expected_slot_count) =>
    shoresh.deleteRecord({ token: currentToken(), entity, entity_id, expected_slot_count }),
  // M3c — the near-duplicate merge gate and the migration review journal.
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  mergeLocation: ({ loser_id, winner_id, winner_capacity, expected_ref_count }) =>
    shoresh.mergeLocation({ token: currentToken(), loser_id, winner_id, winner_capacity, expected_ref_count }),
  listMigrationReviews: () => shoresh.listMigrationReviews(currentToken()),
  dismissMigrationReviews: (ids) => shoresh.dismissMigrationReviews({ token: currentToken(), ids }),
  getDevicePairingStatus: () => shoresh.getDevicePairingStatus(),
  listPendingPairingRequests: () => shoresh.listPendingPairingRequests(currentToken()),
  approveDevice: (deviceId) => shoresh.approveDevice({ token: currentToken(), deviceId }),
  denyDevice: (deviceId) => shoresh.denyDevice({ token: currentToken(), deviceId }),
  listDevices: () => shoresh.listDevices(currentToken()),
  revokeDevice: (deviceId, reason) => shoresh.revokeDevice({ token: currentToken(), deviceId, reason }),
  duplicateWeek: (sourceWeekId, campId) => shoresh.duplicateWeek({ sourceWeekId, campId }),
  // deleteWeekHandler (electron/main.js) destructures { token, weekId } and goes
  // through authorize() — thread the token the same way every other authorized
  // wrapper here does via currentToken(). Fields enumerated explicitly (not
  // spread) so a caller-supplied token in args can never override the real one.
  deleteWeek: ({ weekId }) => shoresh.deleteWeek({ token: currentToken(), weekId }),
  // deleteElectiveSetHandler (electron/main.js) destructures
  // { token, electiveSetId } — same explicit-field-threading discipline as
  // deleteWeek above (T103, docs/adr/2026-08-20-electives-authoring.md).
  deleteElectiveSet: ({ electiveSetId }) =>
    shoresh.deleteElectiveSet({ token: currentToken(), electiveSetId }),
  // deleteSpecialDayHandler (electron/main.js) destructures { token,
  // specialDayId } — same wrapper shape as deleteElectiveSet above (T106,
  // docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md).
  deleteSpecialDay: ({ specialDayId }) =>
    shoresh.deleteSpecialDay({ token: currentToken(), specialDayId }),
  // T105 §2 — the sole reuse/durable-read seam. Never a client-side filter of
  // the generic list('elective_sets') result.
  listDurableElectiveSets: () => shoresh.listDurableElectiveSets(currentToken()),
  onPairingRequest: (cb) => shoresh.onPairingRequest && shoresh.onPairingRequest(cb),
  onPairingApproved: (cb) => shoresh.onPairingApproved && shoresh.onPairingApproved(cb),
  onPairingDenied: (cb) => shoresh.onPairingDenied && shoresh.onPairingDenied(cb),
  onTokenRenewed: (cb) => shoresh.onTokenRenewed && shoresh.onTokenRenewed(cb),
  // docs/adr/2026-08-16-client-reauth-on-restart.md (T87 Part 3)
  onAuthRejected: (cb) => shoresh.onAuthRejected && shoresh.onAuthRejected(cb),
  // No payload — mirrors onOpApplied's subscribe/unsubscribe shape but the
  // event carries nothing beyond "it happened". See preload.js.
  onFullSyncApplied: (cb) => shoresh.onFullSyncApplied(cb),

  // §9 project-file lifecycle (electron/preload.js, ADR
  // 2026-08-04-project-lifecycle-authorization-exemption.md). These are
  // trusted local-device operations, exempt from camp session authorization
  // by recorded decision — no token is threaded through these and none must
  // be added.
  getCurrentProject: () => shoresh.getCurrentProject(),
  createProject: () => shoresh.createProject(),
  openProject: () => shoresh.openProject(),
  exportProject: () => shoresh.exportProject(),
  backupProject: () => shoresh.backupProject(),
  restoreProject: () => shoresh.restoreProject(),
  listRecentProjects: () => shoresh.listRecentProjects(),
  openRecentProject: (targetPath) => shoresh.openRecentProject(targetPath),
}
