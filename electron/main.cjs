'use strict';
/*
 * Mochi — Electron main process.
 *
 * CommonJS (.cjs) because package.json is "type": "module".
 * Owns: BrowserWindow (transparent, frameless, always-on-top), tray icon,
 * global shortcut (user-customizable panel hotkey), single-instance lock,
 * renderer crash recovery, config persistence (mochi.config.json), window
 * position memory (userData/position.json), login-item toggle, --smoke test
 * mode, and the full mochi:* IPC bridge consumed via electron/preload.cjs.
 *
 * No network calls, no telemetry. No AI provider / API key / secret handling.
 * (The opt-in auto-updater lazily loads electron-updater only when enabled;
 * see the AUTO-UPDATE CONTRACT section.)
 */

const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  globalShortcut,
  nativeImage,
  screen,
} = require('electron');

// Lazy-loaded below in the auto-update section (only imported when the user
// opts in) so default builds never touch the network.

const SMOKE_MODE = process.argv.includes('--smoke');
const IS_ROOT =
  typeof process.getuid === 'function' && process.getuid() === 0;

// Chromium refuses to start as root without this (CI / containers).
// Best-effort fallback: the native startup check runs before this JS loads,
// so launchers should ALSO pass --no-sandbox on the real command line
// (scripts/smoke.cjs does this automatically when uid is 0).
if (IS_ROOT) {
  app.commandLine.appendSwitch('no-sandbox');
}

/* ------------------------------------------------------- single-instance */

// Only one Mochi may run at a time. A second launch is redirected here and
// exits; the running instance restores/focuses its window in the
// 'second-instance' handler (registered in the lifecycle section below).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------------------------------------------ config */

const CONFIG_PATH = path.join(__dirname, '..', 'mochi.config.json');

const DEFAULT_CONFIG = {
  provider: 'mock',
  scale: 4,
  calmMode: false,
  soundsEnabled: false,
  userName: '',
  workingFolder: '',
  openAtLogin: false,
  autoUpdate: false,
  panelHotkey: 'CmdOrCtrl+Shift+M',
  sleepAfterMinutes: 5,
  peekMode: false,
  pomodoro: { enabled: false, focusMinutes: 25, breakMinutes: 5 },
  reminders: { stretch: true, water: true, intervalMinutes: 45 },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch || {})) {
    if (isPlainObject(base[key]) && isPlainObject(patch[key])) {
      out[key] = deepMerge(base[key], patch[key]);
    } else {
      out[key] = patch[key];
    }
  }
  return out;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    // Missing or corrupt config: fall back to defaults (deep copy).
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

let config = loadConfig();

function persistConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[mochi] failed to write config:', err.message);
  }
}

function applyLoginItemSetting() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin });
  } catch (err) {
    console.error('[mochi] setLoginItemSettings failed:', err.message);
  }
}

/* --------------------------------------------------------- position memory */

function positionFile() {
  return path.join(app.getPath('userData'), 'position.json');
}

function loadPosition() {
  try {
    const p = JSON.parse(fs.readFileSync(positionFile(), 'utf8'));
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  } catch {
    // No saved position yet — caller falls back to the default placement.
  }
  return null;
}

// Ignore a saved position that would strand the window off every display
// (e.g. a monitor was unplugged since the last session).
function positionOnScreen(pos) {
  try {
    const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
    const a = display.workArea;
    return (
      pos.x >= a.x - 200 &&
      pos.x <= a.x + a.width &&
      pos.y >= a.y - 200 &&
      pos.y <= a.y + a.height
    );
  } catch {
    return true;
  }
}

let savePositionTimer = null;
function savePositionDebounced(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  clearTimeout(savePositionTimer);
  savePositionTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(positionFile()), { recursive: true });
      fs.writeFileSync(
        positionFile(),
        JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
        'utf8'
      );
    } catch (err) {
      console.error('[mochi] failed to save position:', err.message);
    }
  }, 400);
}

/* ------------------------------------------- tray icon (pure-JS PNG, zlib) */

// ORIGINAL 16x16 white-dog-face pixel pattern, drawn for this project.
// '.' = transparent, 'W' = white, 'k' = dark outline (#3a3f4a).
const DOG_FACE = [
  '................',
  '..kk......kk....',
  '.kWWk....kWWk...',
  '.kWWk....kWWk...',
  '.kWWkkkkkkWWk...',
  '..kWWWWWWWWk....',
  '..kWWWWWWWWk....',
  '..kWkkWWkkWk....',
  '..kWkkWWkkWk....',
  '..kWWWWWWWWk....',
  '...kWWkkWWk.....',
  '...kWWkkWWk.....',
  '....kWWWWk......',
  '.....kkkk.......',
  '................',
  '................',
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function buildTrayPng() {
  const W = 16;
  const H = 16;
  const WHITE = [255, 255, 255, 255];
  const INK = [0x3a, 0x3f, 0x4a, 255];
  const CLEAR = [0, 0, 0, 0];
  const rows = [];
  for (const line of DOG_FACE) {
    if (line.length !== W) throw new Error('tray pattern row is not 16 chars');
    const row = Buffer.alloc(1 + W * 4);
    row[0] = 0; // PNG filter: None
    for (let x = 0; x < W; x++) {
      const ch = line[x];
      const px = ch === 'W' ? WHITE : ch === 'k' ? INK : CLEAR;
      row[1 + x * 4] = px[0];
      row[1 + x * 4 + 1] = px[1];
      row[1 + x * 4 + 2] = px[2];
      row[1 + x * 4 + 3] = px[3];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // ihdr[10..12] = compression / filter / interlace, all zero
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ window */

let win = null;
let tray = null;
let sleeping = false;
let windowVisible = true;

function createWindow() {
  const savedPos = loadPosition();
  const useSavedPos = savedPos && positionOnScreen(savedPos);

  win = new BrowserWindow({
    width: 560,
    height: 480,
    ...(useSavedPos ? { x: savedPos.x, y: savedPos.y } : {}),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive(); // never steal focus on launch
    windowVisible = true;
    refreshTrayMenu();
    if (SMOKE_MODE) {
      setTimeout(async () => {
        // Integration probe: verify the renderer boot completed and all
        // modules were constructed (window.__mochi is set at end of boot.js).
        try {
          const probe = await win.webContents.executeJavaScript(
            `(() => { const m = window.__mochi; return m ? {
              boot: true,
              dog: !!m.dog, panel: !!m.panel, settings: !!m.settings,
              effects: !!m.effects, pomodoro: !!m.pomodoro,
              reminders: !!m.reminders, sound: !!m.sound,
            } : { boot: false }; })()`,
            true
          );
          console.log('[smoke] renderer probe: ' + JSON.stringify(probe));
          if (!probe || probe.boot !== true) {
            console.error('[smoke] FAIL: renderer boot did not complete');
            console.log('SMOKE FAIL');
            app.exit(1);
            return;
          }
        } catch (e) {
          console.error('[smoke] FAIL: probe threw: ' + e.message);
          console.log('SMOKE FAIL');
          app.exit(1);
          return;
        }
        console.log('SMOKE OK');
        app.quit();
      }, 2500);
    }
  });

  win.on('show', () => {
    windowVisible = true;
    refreshTrayMenu();
  });
  win.on('hide', () => {
    windowVisible = false;
    refreshTrayMenu();
  });

  // Crash recovery: if the renderer stops responding, offer to reload it.
  // Chat history is safe — panel.js persists it to localStorage on every
  // message, not on unload.
  win.on('unresponsive', () => {
    const { dialog } = require('electron');
    if (win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Reload', 'Wait'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mochi is not responding',
      message: 'The Mochi window stopped responding.',
      detail: 'Reloading restarts the dog and panel. Your chat history is kept.',
    });
    if (choice === 0 && !win.isDestroyed()) win.webContents.reload();
  });

  if (SMOKE_MODE) {
    // Surface renderer console warnings/errors on stdout for debugging.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) {
        console.log(`[renderer-console] ${sourceId}:${line} ${message}`);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[renderer-load-failed] ${code} ${desc}`);
    });
  }
}

/* -------------------------------------------------------------------- tray */

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: windowVisible ? 'Hide Mochi' : 'Show Mochi',
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide();
        else win.showInactive(); // re-showing never steals focus either
      },
    },
    {
      label: 'Sleep',
      type: 'checkbox',
      checked: sleeping,
      click: () => {
        sleeping = !sleeping;
        if (win) win.webContents.send('mochi:sleep-toggle', { sleeping });
        refreshTrayMenu();
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (!win) return;
        if (!win.isVisible()) win.showInactive();
        win.webContents.send('mochi:open-settings');
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(buildTrayPng());
  tray = new Tray(icon);
  tray.setToolTip('Mochi');
  refreshTrayMenu();
}

/* --------------------------------------- panel hotkey (user-customizable) */

const DEFAULT_PANEL_HOTKEY = 'CmdOrCtrl+Shift+M';

function currentPanelHotkey() {
  const h =
    config && typeof config.panelHotkey === 'string'
      ? config.panelHotkey.trim()
      : '';
  return h || DEFAULT_PANEL_HOTKEY;
}

function onPanelHotkey() {
  if (!win) return;
  if (!win.isVisible()) {
    win.showInactive();
    windowVisible = true;
    refreshTrayMenu();
  }
  win.webContents.send('mochi:toggle-panel');
}

// Register the panel hotkey. Returns true on success; false when Electron
// rejects the accelerator (malformed, already taken, …).
function registerPanelHotkey(accelerator) {
  try {
    const ok = globalShortcut.register(accelerator, onPanelHotkey);
    if (!ok) console.error(`[mochi] global shortcut registration failed: ${accelerator}`);
    return ok;
  } catch (err) {
    console.error('[mochi] globalShortcut error:', err.message);
    return false;
  }
}

// Applied once at launch. If the configured hotkey can't register, fall back
// to the default so Mochi never launches without a working hotkey.
function applyPanelHotkeyAtLaunch() {
  const hotkey = currentPanelHotkey();
  if (registerPanelHotkey(hotkey)) return;
  if (hotkey !== DEFAULT_PANEL_HOTKEY && registerPanelHotkey(DEFAULT_PANEL_HOTKEY)) {
    console.error(`[mochi] falling back to default panel hotkey ${DEFAULT_PANEL_HOTKEY}`);
  }
}

/* ------------------------------------------------------------- tool bridge */

const pendingApprovals = new Map(); // id -> { resolve, timer }

// Renderer answers approval prompts via preload's respondApproval(id, approved).
ipcMain.on('mochi:approval-response', (_e, resp) => {
  if (!resp || typeof resp.id !== 'string') return;
  const pending = pendingApprovals.get(resp.id);
  if (!pending) return;
  pendingApprovals.delete(resp.id);
  clearTimeout(pending.timer);
  pending.resolve(resp.approved === true);
});

// Ask the renderer to approve a non-read-only tool call. Resolves true when
// the user approves; resolves false on deny or after a 60s timeout (default DENY).
function requestApproval(sender, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(payload.id);
      resolve(false);
    }, 60_000);
    pendingApprovals.set(payload.id, { resolve, timer });
    sender.send('mochi:tool-approval', payload);
  });
}

let toolRequestCounter = 0;

async function invokeTool(event, name, args) {
  // electron/tools.cjs is written by another agent; require it lazily so the
  // shell boots fine before the tool layer exists.
  let tools;
  try {
    tools = require('./tools.cjs');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes('tools.cjs')) {
      return { ok: false, error: 'tools not built yet' };
    }
    return { ok: false, error: `tool loader failed: ${(err && err.message) || err}` };
  }

  const toolName = String(name);
  const toolArgs = args && typeof args === 'object' ? args : {};

  // Primary interface (electron/tools.cjs):
  //   invokeTool(name, args, ctx) with ctx = { root, requestApproval }.
  // Read-only tools run directly inside the module; write/shell tools call
  // back into main's requestApproval, which implements the spec'd flow:
  // send `mochi:tool-approval` {id, tool, args, description, detail},
  // await `mochi:approval-response` for that id, 60s timeout → default DENY.
  if (typeof tools.invokeTool === 'function') {
    const requestApprovalFn = (info = {}) =>
      requestApproval(event.sender, {
        id: `tool-${Date.now()}-${(toolRequestCounter += 1)}`,
        tool: info.tool || toolName,
        args: info.args || toolArgs,
        description: info.description || `Run tool "${toolName}"`,
        detail: info.detail || JSON.stringify(toolArgs, null, 2),
      });
    const root =
      config.workingFolder && config.workingFolder.length > 0
        ? config.workingFolder
        : app.getAppPath();
    try {
      return await tools.invokeTool(toolName, toolArgs, {
        root,
        requestApproval: requestApprovalFn,
      });
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // Fallback: registry-style export (tools[name] or tools.get(name)). A tool
  // is read-only only when its own metadata says so; anything else goes
  // through the user-approval flow above (default deny).
  const entry = typeof tools.get === 'function' ? tools.get(toolName) : tools[toolName];
  if (entry == null) {
    return { ok: false, error: `unknown tool: ${toolName}` };
  }

  const readOnly =
    (typeof entry === 'object' && entry !== null && entry.readOnly === true) ||
    (typeof tools.isReadOnly === 'function' && tools.isReadOnly(toolName)) ||
    (Array.isArray(tools.readOnly) && tools.readOnly.includes(toolName)) ||
    (Array.isArray(tools.READ_ONLY) && tools.READ_ONLY.includes(toolName));

  if (!readOnly) {
    const approved = await requestApproval(event.sender, {
      id: `tool-${Date.now()}-${(toolRequestCounter += 1)}`,
      tool: toolName,
      args: toolArgs,
      description:
        (typeof entry === 'object' && entry !== null && entry.description) ||
        `Run tool "${toolName}"`,
      detail:
        (typeof entry === 'object' && entry !== null && entry.detail) ||
        JSON.stringify(toolArgs, null, 2),
    });
    if (!approved) return { ok: false, denied: true };
  }

  const fn =
    typeof entry === 'function'
      ? entry
      : entry.run ||
        entry.invoke ||
        entry.fn ||
        (typeof tools.invoke === 'function' ? (a) => tools.invoke(toolName, a) : null);
  if (typeof fn !== 'function') {
    return { ok: false, error: `tool has no runnable entry: ${toolName}` };
  }

  try {
    const result = await fn(toolArgs);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* ---------------------------------------------------- auto-update (opt-in) */

/*
 * AUTO-UPDATE CONTRACT — wired in Phase A, Settings UI owned by Phase E.
 *
 *   Config key: `autoUpdate` (boolean, default false).
 *   Bridge (preload, window.mochi):
 *     mochi.getAutoUpdate()        -> Promise<boolean>
 *     mochi.setAutoUpdate(enabled) -> Promise<{ ok, autoUpdate }> (applies immediately)
 *     mochi.checkForUpdatesNow()   -> Promise<{ ok, skipped? }>
 *     (checkForUpdatesNow is a no-op { ok: true, skipped: true } unless
 *      the user has opted in — and never runs in --smoke mode.)
 *
 * Privacy: default false means ZERO network calls for updates. The
 * electron-updater module is only required when the user opts in.
 * When enabled: check at launch, re-check every 6h, auto-download,
 * then ask via a dialog before quit-and-install. Updates are published
 * to GitHub Releases (see package.json "build.publish").
 */

let updater = null; // the electron-updater autoUpdater instance, once loaded
let updateCheckTimer = null;

function stopAutoUpdateChecks() {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
}

function startAutoUpdater() {
  if (updater) return; // already running
  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.error('[mochi] electron-updater failed to load:', err.message);
    return;
  }
  autoUpdater.autoDownload = true;

  autoUpdater.on('update-downloaded', () => {
    const { dialog } = require('electron');
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Mochi update ready',
      message: 'A new version of Mochi has been downloaded.',
      detail: 'Install it now? Mochi will restart.',
    });
    if (choice === 0) autoUpdater.quitAndInstall(false, true);
  });
  autoUpdater.on('error', (err) => {
    console.error('[mochi] auto-update error:', (err && err.message) || err);
  });

  updater = autoUpdater;
  updater
    .checkForUpdates()
    .catch((err) => console.error('[mochi] update check failed:', err.message));
  updateCheckTimer = setInterval(
    () => {
      updater
        .checkForUpdates()
        .catch((err) => console.error('[mochi] update check failed:', err.message));
    },
    6 * 60 * 60 * 1000
  );
}

// Called at launch and whenever the config changes. Only starts the updater
// when the user has opted in; never in smoke mode.
function applyAutoUpdateSetting() {
  if (SMOKE_MODE) return;
  if (config.autoUpdate === true) {
    startAutoUpdater();
  } else {
    stopAutoUpdateChecks();
    updater = null;
  }
}

/* --------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('mochi:get-config', () => ({ ...config }));

  ipcMain.handle('mochi:set-config', (_e, patch) => {
    if (patch && typeof patch === 'object') {
      config = deepMerge(config, patch);
      persistConfig();
      applyLoginItemSetting();
      applyAutoUpdateSetting();
      // Notify the renderer so live settings (scale, sounds, peek) apply.
      if (win && !win.isDestroyed()) win.webContents.send('mochi:config-changed', { ...config });
    }
    return { ...config };
  });

  // Auto-update bridge (contract documented in the section above).
  ipcMain.handle('mochi:get-auto-update', () => !!config.autoUpdate);

  ipcMain.handle('mochi:set-auto-update', (_e, enabled) => {
    config = deepMerge(config, { autoUpdate: !!enabled });
    persistConfig();
    applyAutoUpdateSetting();
    // Keep the renderer's config snapshot in sync (same as set-config).
    if (win && !win.isDestroyed()) win.webContents.send('mochi:config-changed', { ...config });
    return { ok: true, autoUpdate: !!config.autoUpdate };
  });

  // Customizable panel hotkey (Settings record-combo control). Validates by
  // actually registering: on failure the OLD hotkey is re-registered and the
  // error is returned so Settings can surface it. The app is never left
  // without a working hotkey.
  ipcMain.handle('mochi:set-panel-hotkey', (_e, accelerator) => {
    const next = typeof accelerator === 'string' ? accelerator.trim() : '';
    const prev = currentPanelHotkey();
    if (!next) {
      return { ok: false, hotkey: prev, error: 'Empty hotkey — nothing changed.' };
    }
    if (next === prev) return { ok: true, hotkey: prev };
    globalShortcut.unregister(prev);
    if (!registerPanelHotkey(next)) {
      // Roll back: re-register the old hotkey so a working one always exists.
      registerPanelHotkey(prev);
      return {
        ok: false,
        hotkey: prev,
        error: `Could not register "${next}" — kept ${prev}.`,
      };
    }
    config = deepMerge(config, { panelHotkey: next });
    persistConfig();
    return { ok: true, hotkey: next };
  });

  ipcMain.handle('mochi:check-for-updates-now', async () => {
    if (SMOKE_MODE || config.autoUpdate !== true || !updater) {
      return { ok: true, skipped: true };
    }
    try {
      await updater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('mochi:get-position', () => loadPosition());

  ipcMain.on('mochi:save-position', (_e, pos) => {
    if (pos && typeof pos === 'object' && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      // Drag: move the window live (persistence stays debounced below).
      if (win) win.setPosition(Math.round(pos.x), Math.round(pos.y));
      savePositionDebounced(pos.x, pos.y);
    }
  });

  ipcMain.on('mochi:ignore-mouse', (_e, ignore) => {
    if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.on('mochi:focus-window', () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    win.focus();
  });

  ipcMain.on('mochi:toggle-panel', () => {
    if (win) win.webContents.send('mochi:toggle-panel');
  });

  ipcMain.handle('mochi:set-open-at-login', (_e, enabled) => {
    config = deepMerge(config, { openAtLogin: !!enabled });
    persistConfig();
    applyLoginItemSetting();
    return { ok: true, openAtLogin: config.openAtLogin };
  });

  ipcMain.on('mochi:quit', () => app.quit());

  ipcMain.handle('mochi:invoke-tool', (event, name, args) => invokeTool(event, name, args));
}

/* --------------------------------------------------------------- lifecycle */

// A second launch exits at the single-instance check above; the running
// instance restores and focuses its window here instead of launching another.
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) {
      win.showInactive();
      windowVisible = true;
      refreshTrayMenu();
    }
    win.focus();
  }
});

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  createTray();
  applyPanelHotkeyAtLaunch();
  applyLoginItemSetting();
  applyAutoUpdateSetting();
});

// Stay alive in the tray when the window is hidden/closed; quit via tray menu.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
