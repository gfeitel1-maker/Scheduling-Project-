const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shoresh', {
  chooseMode: (args) => ipcRenderer.invoke('shoresh:choose-mode', args),
  discoverHosts: () => ipcRenderer.invoke('shoresh:discover-hosts'),
  login: (args) => ipcRenderer.invoke('shoresh:login', args),
  createUser: (args) => ipcRenderer.invoke('shoresh:create-user', args),
  bootstrapCamp: (args) => ipcRenderer.invoke('shoresh:bootstrap-camp', args),
  write: (args) => ipcRenderer.invoke('shoresh:write', args),
  bulkReplace: (args) => ipcRenderer.invoke('shoresh:bulk-replace', args),
  verifySession: (args) => ipcRenderer.invoke('shoresh:verify-session', args),
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
  // No payload — mirrors onOpApplied's exact shape (subscribe/unsubscribe),
  // but the event itself carries nothing beyond "it happened". Consumed by
  // the first-sync write-gate (slice 2).
  onFullSyncApplied: (callback) => {
    const wrapped = () => callback()
    ipcRenderer.on('shoresh:full-sync-applied', wrapped)
    return () => ipcRenderer.removeListener('shoresh:full-sync-applied', wrapped)
  },
  getCamp: () => ipcRenderer.invoke('shoresh:get-camp'),
  listUsers: (token) => ipcRenderer.invoke('shoresh:list-users', { token }),
  list: (token, entity) => ipcRenderer.invoke('shoresh:list', { token, entity }),
  listByScope: (token, entity, scopeId) => ipcRenderer.invoke('shoresh:list-by-scope', { token, entity, scopeId }),
  getDeviceId: (token) => ipcRenderer.invoke('shoresh:get-device-id', { token }),
  resolveConflict: (args) => ipcRenderer.invoke('shoresh:resolve-conflict', args),
  listPendingConflicts: (token) => ipcRenderer.invoke('shoresh:list-conflicts', { token }),
  listDeleted: (token) => ipcRenderer.invoke('shoresh:list-deleted', { token }),
  listPendingRestores: (token) => ipcRenderer.invoke('shoresh:list-pending-restores', { token }),
  getEntityHistory: (args) => ipcRenderer.invoke('shoresh:get-entity-history', args),
  restoreEntity: (args) => ipcRenderer.invoke('shoresh:restore-entity', args),
  previewDelete: (args) => ipcRenderer.invoke('shoresh:preview-delete', args),
  deleteRecord: (args) => ipcRenderer.invoke('shoresh:delete-record', args),
  getDevicePairingStatus: () => ipcRenderer.invoke('shoresh:get-device-pairing-status'),
  listPendingPairingRequests: (token) => ipcRenderer.invoke('shoresh:list-pending-pairing-requests', { token }),
  approveDevice: (args) => ipcRenderer.invoke('shoresh:approve-device', args),
  denyDevice: (args) => ipcRenderer.invoke('shoresh:deny-device', args),
  listDevices: (token) => ipcRenderer.invoke('shoresh:list-devices', { token }),
  revokeDevice: (args) => ipcRenderer.invoke('shoresh:revoke-device', args),
  onPairingRequest: (callback) => ipcRenderer.on('shoresh:pairing-request', (_event, data) => callback(data)),
  onPairingApproved: (callback) => ipcRenderer.on('shoresh:pairing-approved', () => callback()),
  onPairingDenied: (callback) => ipcRenderer.on('shoresh:pairing-denied', () => callback()),
  onTokenRenewed: (callback) => ipcRenderer.on('shoresh:token-renewed', (_event, data) => callback(data.token)),
  // §9 project-file lifecycle
  getCurrentProject: () => ipcRenderer.invoke('shoresh:get-current-project'),
  // T27 — read-only status, plus a push so it does not go stale. A value read
  // once at mount is wrong within minutes: a laptop closes, wifi drops.
  getSyncStatus: () => ipcRenderer.invoke('shoresh:get-sync-status'),
  ingestCommit: (args) => ipcRenderer.invoke('shoresh:ingest-commit', args),
  // S1b — confirm that an imported label means an existing entity, so the next
  // import recognizes it without re-asking (docs/adr/2026-08-09-s1b-host-local-aliases.md).
  confirmAlias: (args) => ipcRenderer.invoke('shoresh:confirm-alias', args),
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
  restoreProject: () => ipcRenderer.invoke('shoresh:restore-project'),
  listRecentProjects: () => ipcRenderer.invoke('shoresh:list-recent-projects'),
  openRecentProject: (targetPath) => ipcRenderer.invoke('shoresh:open-recent-project', { path: targetPath }),
  duplicateWeek: (args) => ipcRenderer.invoke('shoresh:duplicate-week', args),
  deleteWeek: (args) => ipcRenderer.invoke('shoresh:delete-week', args),
})
