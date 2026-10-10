'use strict';
/*
 * Mochi preload — minimal bridge.
 *
 * Runs sandboxed with contextIsolation on and nodeIntegration off.
 * Exposes ONLY window.mochi with the exact surface below. No Node APIs,
 * no direct ipcRenderer access, and no other globals leak to the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mochi', {
  platform: process.platform,

  getConfig: () => ipcRenderer.invoke('mochi:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('mochi:set-config', patch),

  getPosition: () => ipcRenderer.invoke('mochi:get-position'),
  savePosition: (x, y) => ipcRenderer.send('mochi:save-position', { x, y }),

  getDockGeometry: () => ipcRenderer.invoke('mochi:get-dock-geometry'),
  glide: (x, y, ms) => ipcRenderer.invoke('mochi:glide', { x, y, ms }),
  cancelGlide: () => ipcRenderer.send('mochi:cancel-glide'),
  setDocked: (v) => ipcRenderer.send('mochi:set-docked', !!v),
  onDockNow: (cb) => subscribe('mochi:dock-now', cb),
  onDockState: (cb) => subscribe('mochi:dock-state', cb),

  getWanderBounds: () => ipcRenderer.invoke('mochi:get-wander-bounds'),
  setPanelOpen: (open) => ipcRenderer.send('mochi:panel-open', !!open),

  getDisplays: () => ipcRenderer.invoke('mochi:get-displays'),
  getScreenSize: () => ipcRenderer.invoke('mochi:get-screen-size'),

  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('mochi:ignore-mouse', ignore),
  focusWindow: () => ipcRenderer.send('mochi:focus-window'),
  togglePanel: () => ipcRenderer.send('mochi:toggle-panel'),

  onTogglePanel: (cb) => subscribe('mochi:toggle-panel', cb),
  onSleepToggle: (cb) => subscribe('mochi:sleep-toggle', cb),
  onOpenSettings: (cb) => subscribe('mochi:open-settings', cb),
  onConfigChanged: (cb) => subscribe('mochi:config-changed', cb),

  setOpenAtLogin: (enabled) => ipcRenderer.invoke('mochi:set-open-at-login', enabled),
  quit: () => ipcRenderer.send('mochi:quit'),
});
