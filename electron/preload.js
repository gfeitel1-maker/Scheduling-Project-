import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('shoresh', {
  chooseMode: (args) => ipcRenderer.invoke('shoresh:choose-mode', args),
  discoverHosts: () => ipcRenderer.invoke('shoresh:discover-hosts'),
  login: (args) => ipcRenderer.invoke('shoresh:login', args),
  createUser: (args) => ipcRenderer.invoke('shoresh:create-user', args),
  write: (args) => ipcRenderer.invoke('shoresh:write', args),
  onOpApplied: (callback) => ipcRenderer.on('shoresh:op-applied', (_event, op) => callback(op)),
  getCamp: () => ipcRenderer.invoke('shoresh:get-camp'),
})
