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

  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('mochi:ignore-mouse', ignore),
  focusWindow: () => ipcRenderer.send('mochi:focus-window'),
  togglePanel: () => ipcRenderer.send('mochi:toggle-panel'),

  onTogglePanel: (cb) => subscribe('mochi:toggle-panel', cb),
  onSleepToggle: (cb) => subscribe('mochi:sleep-toggle', cb),
  onOpenSettings: (cb) => subscribe('mochi:open-settings', cb),
  onToolApprovalRequest: (cb) => subscribe('mochi:tool-approval', cb),
  onConfigChanged: (cb) => subscribe('mochi:config-changed', cb),
  respondApproval: (id, approved) =>
    ipcRenderer.send('mochi:approval-response', { id, approved }),

  invokeTool: (name, args) => ipcRenderer.invoke('mochi:invoke-tool', name, args),

  // Auto-update (opt-in). Contract: getAutoUpdate -> Promise<boolean>;
  // setAutoUpdate(enabled) -> Promise<{ok, autoUpdate}>; checkForUpdatesNow()
  // triggers a manual check, resolving {ok, skipped: true} unless opted in.
  // The Settings auto-update checkbox (settings.js) calls setAutoUpdate.
  getAutoUpdate: () => ipcRenderer.invoke('mochi:get-auto-update'),
  setAutoUpdate: (enabled) =>
    ipcRenderer.invoke('mochi:set-auto-update', enabled),
  checkForUpdatesNow: () => ipcRenderer.invoke('mochi:check-for-updates-now'),

  // Customizable panel hotkey (Settings record-combo control). Resolves
  // { ok, hotkey }; on failure { ok: false, hotkey, error } and the old
  // hotkey stays registered.
  setPanelHotkey: (accelerator) =>
    ipcRenderer.invoke('mochi:set-panel-hotkey', accelerator),

  setOpenAtLogin: (enabled) => ipcRenderer.invoke('mochi:set-open-at-login', enabled),
  quit: () => ipcRenderer.send('mochi:quit'),
});
