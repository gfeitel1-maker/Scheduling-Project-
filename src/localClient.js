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
  ingestCommit: ({ approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions } = {}) =>
    shoresh.ingestCommit({ token: currentToken(), approved, links, cohort_id, fixedEvents, activityRules, mode, resolutions }),
  onSyncStatusChanged: (cb) => shoresh.onSyncStatusChanged?.(cb) ?? (() => {}),
  onOpConflict: (cb) => shoresh.onOpConflict(cb),
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
  onPairingRequest: (cb) => shoresh.onPairingRequest && shoresh.onPairingRequest(cb),
  onPairingApproved: (cb) => shoresh.onPairingApproved && shoresh.onPairingApproved(cb),
  onPairingDenied: (cb) => shoresh.onPairingDenied && shoresh.onPairingDenied(cb),
  onTokenRenewed: (cb) => shoresh.onTokenRenewed && shoresh.onTokenRenewed(cb),
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
