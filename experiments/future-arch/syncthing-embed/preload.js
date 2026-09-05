'use strict';
/*
 * preload.js — safe contextBridge surface for the renderer.
 * No Node/Electron internals leak through; only the two calls the
 * prototype's UI needs.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncthingBridge', {
  getStatus: () => ipcRenderer.invoke('syncthing:getStatus'),
  addPeer: (peerId) => ipcRenderer.invoke('syncthing:addPeer', peerId),
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('syncthing:status', handler);
    return () => ipcRenderer.removeListener('syncthing:status', handler);
  },
});

contextBridge.exposeInMainWorld('shoreshBridge', {
  edit: (entityId, field, value) => ipcRenderer.invoke('shoresh:edit', { entityId, field, value }),
  getState: () => ipcRenderer.invoke('shoresh:state'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('shoresh:state', handler);
    return () => ipcRenderer.removeListener('shoresh:state', handler);
  },
});
