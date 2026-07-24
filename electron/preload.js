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
  onOpApplied: (callback) => ipcRenderer.on('shoresh:op-applied', (_event, op) => callback(op)),
  onOpConflict: (callback) => ipcRenderer.on('shoresh:op-conflict', (_event, msg) => callback(msg)),
  getCamp: () => ipcRenderer.invoke('shoresh:get-camp'),
  listUsers: (token) => ipcRenderer.invoke('shoresh:list-users', { token }),
  list: (token, entity) => ipcRenderer.invoke('shoresh:list', { token, entity }),
  getDeviceId: (token) => ipcRenderer.invoke('shoresh:get-device-id', { token }),
  resolveConflict: (args) => ipcRenderer.invoke('shoresh:resolve-conflict', args),
  listPendingConflicts: (token) => ipcRenderer.invoke('shoresh:list-conflicts', { token }),
})
