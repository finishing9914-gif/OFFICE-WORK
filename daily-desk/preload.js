'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only these functions are exposed to the window. No raw Node access.
contextBridge.exposeInMainWorld('desk', {
  status: () => ipcRenderer.invoke('app:status'),
  init: (password) => ipcRenderer.invoke('vault:init', password),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
  lock: () => ipcRenderer.invoke('vault:lock'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  connectCloud: () => ipcRenderer.invoke('cloud:connect'),
  disconnectCloud: () => ipcRenderer.invoke('cloud:disconnect'),
  syncCloud: () => ipcRenderer.invoke('cloud:sync'),
  onDataUpdated: (cb) => ipcRenderer.on('data:updated', (_e, d) => cb(d)),
  onLocked: (cb) => ipcRenderer.on('vault:locked', () => cb()),
});
