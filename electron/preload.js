const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shoresh', {
  chooseMode: (args) => ipcRenderer.invoke('shoresh:choose-mode', args),
  login: (args) => ipcRenderer.invoke('shoresh:login', args),
  createUser: (args) => ipcRenderer.invoke('shoresh:create-user', args),
  promoteToAdmin: (args) => ipcRenderer.invoke('shoresh:promote-to-admin', args),
  bootstrapCamp: (args) => ipcRenderer.invoke('shoresh:bootstrap-camp', args),
  write: (args) => ipcRenderer.invoke('shoresh:write', args),
  bulkReplace: (args) => ipcRenderer.invoke('shoresh:bulk-replace', args),
  verifySession: (args) => ipcRenderer.invoke('shoresh:verify-session', args),
  // Deploy smoke-test heartbeat. Called once from App's mount effect; main
  // writes the smoke marker only when SHORESH_SMOKE_NONCE is set (a no-op
  // round-trip otherwise). See electron/main.js and scripts/deploy-local.sh.
  reportSmokeReady: () => ipcRenderer.invoke('shoresh:smoke-ready'),
  getBootFailure: () => ipcRenderer.invoke('shoresh:get-boot-failure'),
  quitApp: () => ipcRenderer.invoke('shoresh:quit-app'),
  onOpApplied: (callback) => {
    const wrapped = (_event, op) => callback(op)
    ipcRenderer.on('shoresh:op-applied', wrapped)
    return () => ipcRenderer.removeListener('shoresh:op-applied', wrapped)
  },
  onOpConflict: (callback) => {
    const wrapped = (_event, msg) => callback(msg)
    ipcRenderer.on('shoresh:op-conflict', wrapped)
    return () => ipcRenderer.removeListener('shoresh:op-conflict', wrapped)
  },
  // docs/adr/2026-08-15-locations-concurrent-create-collision.md — mirrors
  // onOpConflict's exact shape.
  onOpRejected: (callback) => {
    const wrapped = (_event, msg) => callback(msg)
    ipcRenderer.on('shoresh:op-rejected', wrapped)
    return () => ipcRenderer.removeListener('shoresh:op-rejected', wrapped)
  },
  // No payload — mirrors onOpApplied's exact shape (subscribe/unsubscribe),
  // but the event itself carries nothing beyond "it happened". Consumed by
  // the first-sync write-gate (slice 2).
  onFullSyncApplied: (callback) => {
    const wrapped = () => callback()
    ipcRenderer.on('shoresh:full-sync-applied', wrapped)
    return () => ipcRenderer.removeListener('shoresh:full-sync-applied', wrapped)
  },
  getCamp: () => ipcRenderer.invoke('shoresh:get-camp'),
  // Stage-aware landing (docs/adr/2026-08-28-stage-aware-nav-landing.md)
  campHasSetupData: () => ipcRenderer.invoke('shoresh:camp-has-setup-data'),
  listUsers: (token) => ipcRenderer.invoke('shoresh:list-users', { token }),
  list: (token, entity) => ipcRenderer.invoke('shoresh:list', { token, entity }),
  listByScope: (token, entity, scopeId) => ipcRenderer.invoke('shoresh:list-by-scope', { token, entity, scopeId }),
  getDeviceId: (token) => ipcRenderer.invoke('shoresh:get-device-id', { token }),
  resolveConflict: (args) => ipcRenderer.invoke('shoresh:resolve-conflict', args),
  listPendingConflicts: (token) => ipcRenderer.invoke('shoresh:list-conflicts', { token }),
  listDeleted: (token) => ipcRenderer.invoke('shoresh:list-deleted', { token }),
  getEntityHistory: (args) => ipcRenderer.invoke('shoresh:get-entity-history', args),
  restoreEntity: (args) => ipcRenderer.invoke('shoresh:restore-entity', args),
  previewDelete: (args) => ipcRenderer.invoke('shoresh:preview-delete', args),
  deleteRecord: (args) => ipcRenderer.invoke('shoresh:delete-record', args),
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md (M3c)
  mergeLocation: (args) => ipcRenderer.invoke('shoresh:merge-location', args),
  mergeActivity: (args) => ipcRenderer.invoke('shoresh:merge-activity', args),
  previewActivityMerge: (args) => ipcRenderer.invoke('shoresh:preview-activity-merge', args),
  listMigrationReviews: (token) => ipcRenderer.invoke('shoresh:list-migration-reviews', { token }),
  dismissMigrationReviews: (args) => ipcRenderer.invoke('shoresh:dismiss-migration-reviews', args),
  listOpenReconciliationDecisions: (token) => ipcRenderer.invoke('shoresh:list-open-reconciliation-decisions', { token }),
  dismissOpenReconciliationDecisions: (args) => ipcRenderer.invoke('shoresh:dismiss-open-reconciliation-decisions', args),
  getDevicePairingStatus: () => ipcRenderer.invoke('shoresh:get-device-pairing-status'),
  listPendingPairingRequests: (token) => ipcRenderer.invoke('shoresh:list-pending-pairing-requests', { token }),
  approveDevice: (args) => ipcRenderer.invoke('shoresh:approve-device', args),
  listToolAuthorizations: (token) => ipcRenderer.invoke('shoresh:list-tool-authorizations', { token }),
  grantToolAuthorization: (args) => ipcRenderer.invoke('shoresh:grant-tool-authorization', args),
  revokeToolAuthorization: (args) => ipcRenderer.invoke('shoresh:revoke-tool-authorization', args),
  // Join flow — docs/adr/2026-09-08-libp2p-join-flow.md. The join-* calls are
  // token-free by construction: a device with no camp has no session to pass.
  getSyncEngine: () => ipcRenderer.invoke('shoresh:get-sync-engine'),
  getJoinCode: (args) => ipcRenderer.invoke('shoresh:get-join-code', args),
  setJoinWindow: (args) => ipcRenderer.invoke('shoresh:set-join-window', args),
  // Planned host handoff (docs/adr/2026-10-09-host-succession-simple.md).
  handoffStatus: (args) => ipcRenderer.invoke('shoresh:handoff-status', args),
  handoffStart: (args) => ipcRenderer.invoke('shoresh:handoff-start', args),
  handoffAccept: (args) => ipcRenderer.invoke('shoresh:handoff-accept', args),
  handoffDecline: (args) => ipcRenderer.invoke('shoresh:handoff-decline', args),
  onHandoffChanged: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('shoresh:handoff-changed', listener)
    return () => ipcRenderer.removeListener('shoresh:handoff-changed', listener)
  },
  joinStart: (args) => ipcRenderer.invoke('shoresh:join-start', args),
  joinFindHost: () => ipcRenderer.invoke('shoresh:join-find-host'),
  joinRequestPairing: () => ipcRenderer.invoke('shoresh:join-request-pairing'),
  joinAwaitPairingDecision: () => ipcRenderer.invoke('shoresh:join-await-pairing-decision'),
  joinLogin: (args) => ipcRenderer.invoke('shoresh:join-login', args),
  joinAwaitData: () => ipcRenderer.invoke('shoresh:join-await-data'),
  joinCancel: () => ipcRenderer.invoke('shoresh:join-cancel'),
  denyDevice: (args) => ipcRenderer.invoke('shoresh:deny-device', args),
  listDevices: (token) => ipcRenderer.invoke('shoresh:list-devices', { token }),
  listPeerErasureState: (token) => ipcRenderer.invoke('shoresh:list-peer-erasure-state', { token }),
  importSetupRows: (args) => ipcRenderer.invoke('shoresh:import-setup-rows', args),
  revokeDevice: (args) => ipcRenderer.invoke('shoresh:revoke-device', args),
  renameDevice: (args) => ipcRenderer.invoke('shoresh:rename-device', args),
  onPairingRequest: (callback) => ipcRenderer.on('shoresh:pairing-request', (_event, data) => callback(data)),
  // T87 (docs/adr/2026-08-16-client-reauth-on-restart.md, Part 3) — forwards a
  // field off the payload rather than the payload itself; carries only the
  // numeric close code. _Prior: this comment described the shape as mirroring
  // ~~onTokenRenewed~~, which was removed as an orphaned channel with no sender._
  onAuthRejected: (callback) => ipcRenderer.on('shoresh:auth-rejected', (_event, data) => callback(data.code)),
  // §9 project-file lifecycle
  getCurrentProject: () => ipcRenderer.invoke('shoresh:get-current-project'),
  // T27 — read-only status, plus a push so it does not go stale. A value read
  // once at mount is wrong within minutes: a laptop closes, wifi drops.
  getSyncStatus: () => ipcRenderer.invoke('shoresh:get-sync-status'),
  // T359 slice 4 - { status, reason?, leaseSeconds? } or null (flag off, mapper not started, unknown).
  // Never the router-reported address or port.
  getPortMappingStatus: () => ipcRenderer.invoke('shoresh:get-port-mapping-status'),
  // T275 — the sidebar's host-not-syncing retry affordance. A bare
  // re-invocation of the same guarded starter getSyncStatus's state already
  // comes from; the real outcome surfaces via the next getSyncStatus poll /
  // shoresh:sync-status-changed push, never via this call's return value.
  retrySync: () => ipcRenderer.invoke('shoresh:retry-sync'),
  ingestCommit: (args) => ipcRenderer.invoke('shoresh:ingest-commit', args),
  ingestReconcile: (args) => ipcRenderer.invoke('shoresh:ingest-reconcile', args),
  ingestUndo: (args) => ipcRenderer.invoke('shoresh:ingest-undo', args),
  // S1b — confirm that an imported label means an existing entity, so the next
  // import recognizes it without re-asking (docs/adr/2026-08-09-s1b-host-local-aliases.md).
  confirmAlias: (args) => ipcRenderer.invoke('shoresh:confirm-alias', args),
  // Slice 2a (two-rows split decline-memory, docs/adr/2026-08-23-two-rows-
  // multipattern-split.md) — record/read a director's "not now" on a split
  // suggestion, so re-import does not re-suggest it.
  recordDeclinedSplit: (args) => ipcRenderer.invoke('shoresh:record-declined-split', args),
  recordImportDecisions: (args) => ipcRenderer.invoke('shoresh:record-import-decisions', args),
  rememberColumnMapping: (args) => ipcRenderer.invoke('shoresh:remember-column-mapping', args),
  listDeclinedSplitNames: (args) => ipcRenderer.invoke('shoresh:list-declined-split-names', args),
  // T118 slice 4 — read the camp's confirmed compound-cell-pattern decisions
  // (docs/adr/2026-09-03-compound-cell-interpretation.md), so a resolved
  // pattern never asks again on a later import.
  listCompoundCellDecisions: (args) => ipcRenderer.invoke('shoresh:list-compound-cell-decisions', args),
  latestOpSeq: () => ipcRenderer.invoke('shoresh:latest-op-seq'),
  onSyncStatusChanged: (cb) => {
    const listener = (_e, status) => cb(status)
    ipcRenderer.on('shoresh:sync-status-changed', listener)
    return () => ipcRenderer.removeListener('shoresh:sync-status-changed', listener)
  },
  createProject: () => ipcRenderer.invoke('shoresh:create-project'),
  openProject: () => ipcRenderer.invoke('shoresh:open-project'),
  exportProject: () => ipcRenderer.invoke('shoresh:export-project'),
  backupProject: () => ipcRenderer.invoke('shoresh:backup-project'),
  showBackupInFolder: () => ipcRenderer.invoke('shoresh:show-backup-in-folder'),
  pickRestoreBackup: () => ipcRenderer.invoke('shoresh:pick-restore-backup'),
  restoreProject: () => ipcRenderer.invoke('shoresh:restore-project'),
  listRecentProjects: () => ipcRenderer.invoke('shoresh:list-recent-projects'),
  openRecentProject: (targetPath) => ipcRenderer.invoke('shoresh:open-recent-project', { path: targetPath }),
  duplicateWeek: (args) => ipcRenderer.invoke('shoresh:duplicate-week', args),
  deleteWeek: (args) => ipcRenderer.invoke('shoresh:delete-week', args),
  deleteElectiveSet: (args) => ipcRenderer.invoke('shoresh:delete-elective-set', args),
  deleteElectiveRun: (args) => ipcRenderer.invoke('shoresh:delete-elective-run', args),
  purgeElectiveSeason: (args) => ipcRenderer.invoke('shoresh:purge-elective-season', args),
  deleteSpecialDay: (args) => ipcRenderer.invoke('shoresh:delete-special-day', args),
  bindSpecialDay: (args) => ipcRenderer.invoke('shoresh:bind-special-day', args),
  unbindSpecialDay: (args) => ipcRenderer.invoke('shoresh:unbind-special-day', args),
  deleteEvent: (args) => ipcRenderer.invoke('shoresh:delete-event', args),
  // T105: the durability read seam's first production caller
  // (electron/ops/durableElectiveSets.js, T110) — mirrors listUsers's shape.
  listDurableElectiveSets: (token) => ipcRenderer.invoke('shoresh:list-durable-elective-sets', { token }),
  // The individual-elective run path (T227). Admin-only in the main process;
  // the renderer parses the sheet itself and only the WRITE crosses here.
  commitElectiveRun: (args) => ipcRenderer.invoke('shoresh:commit-elective-run', args),
  listElectiveRuns: (token) => ipcRenderer.invoke('shoresh:list-elective-runs', { token }),
  getElectiveRun: (args) => ipcRenderer.invoke('shoresh:get-elective-run', args),
  finalizeElectiveRun: (args) => ipcRenderer.invoke('shoresh:finalize-elective-run', args),
  // T245 — draft move/lock. Admin-only in the main process, same as the
  // commits above. Appended; do not reorder.
  setElectiveAssignment: (args) => ipcRenderer.invoke('shoresh:set-elective-assignment', args),
  // T297 — editing what a camper ASKED for, as distinct from the placement
  // they got above.
  setElectivePreference: (args) => ipcRenderer.invoke('shoresh:set-elective-preference', args),
  removeElectivePreference: (args) => ipcRenderer.invoke('shoresh:remove-elective-preference', args),
  // T306 — names an unnamed subject the import landed. Authorized as
  // 'campers.attribute' (staff-reachable per the owner ruling of 2026-09-29),
  // deliberately NOT 'campers.write'. RESOLVES to {ok:false,error} on refusal
  // rather than rejecting, so a caller must check `ok`.
  attributeSubject: (args) => ipcRenderer.invoke('shoresh:attribute-subject', args),
  // T248 — per-camper outer schedule read (final-run snapshot or draft-derive).
  getElectiveRunOuterSchedule: (args) => ipcRenderer.invoke('shoresh:get-elective-run-outer-schedule', args),
  // T249 — read-only device build posture (at-rest encryption on/off). No
  // token: public configuration, not camp data (see getSecurityStatusHandler in
  // electron/main.js). Appended per the ADR's merge-order note; do not reorder.
  getSecurityStatus: () => ipcRenderer.invoke('shoresh:get-security-status'),
  // Slice D — read-only, mirrors listDurableElectiveSets's shape.
  listImportEvidence: (token) => ipcRenderer.invoke('shoresh:list-import-evidence', { token }),
  // T114 follow-up — read-only, mirrors listImportEvidence's shape for the
  // one inferred field a group has (its age division).
  listDivisionEvidence: (token) => ipcRenderer.invoke('shoresh:list-division-evidence', { token }),
  // T119 — read-only, mirrors listImportEvidence's shape.
  locationCapacityProvenance: (token) => ipcRenderer.invoke('shoresh:location-capacity-provenance', { token }),
  // Tile World viewer — opens a standalone Phaser window served over local HTTP+WS.
})
