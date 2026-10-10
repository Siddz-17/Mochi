'use strict';
/*
 * Mochi — Electron main process.
 *
 * CommonJS (.cjs) because package.json is "type": "module".
 * Owns: BrowserWindow (transparent, frameless, always-on-top), tray icon,
 * global shortcut, config persistence (mochi.config.json), window position
 * memory (userData/position.json), login-item toggle, --smoke test mode,
 * and the minimal mochi:* IPC bridge consumed via electron/preload.cjs.
 *
 * No network calls, no telemetry.
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

const SMOKE_MODE = process.argv.includes('--smoke');
const IS_ROOT =
  typeof process.getuid === 'function' && process.getuid() === 0;

// Chromium refuses to start as root without this (CI / containers).
if (IS_ROOT) {
  app.commandLine.appendSwitch('no-sandbox');
}

// Transparent windows can render as fully invisible with some Windows GPU
// drivers. Launch with `npm start -- --no-gpu` to rule that out.
if (process.argv.includes('--no-gpu')) {
  app.disableHardwareAcceleration();
}

// Log file so problems are visible even when the window is not:
// %APPDATA%\mochi\mochi.log
function logLine(msg) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'mochi.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {
    /* logging must never crash the app */
  }
}

if (!SMOKE_MODE) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    console.log('[mochi] another instance is already running; exiting.');
    app.quit();
    process.exit(0);
  } else {
    // Launching again (e.g. a stale/invisible copy is already running) should
    // REVEAL the existing dog instead of silently doing nothing.
    app.on('second-instance', () => {
      if (win) {
        forceOut();
        const p = defaultPosition();
        moveWindow(p.x, p.y);
        if (!win.isVisible()) win.show();
        win.setAlwaysOnTop(true);
        win.moveTop();
        win.webContents.send('mochi:toggle-panel');
      }
    });
  }
}

/* ------------------------------------------------------------------ config */

const CONFIG_PATH = path.join(__dirname, '..', 'mochi.config.json');

const DEFAULT_CONFIG = {
  provider: 'mock',
  scale: 4,
  userName: '',
  wanderEnabled: true,
  homeDisplayId: null,
  dockEnabled: true,
  dockIdleSeconds: 20,
  dockPeekPx: 44,
  calmMode: false,
  sleepAfterMinutes: 5,
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
    // No saved position yet
  }
  return null;
}

/* ------------------------------------------------------- screen geometry
 * The window is a fixed 560x480 transparent box; the dog sits in its
 * bottom-right corner and the chat panel opens up/left of the dog.
 * ALL window moves are clamped here, in the main process, so the dog can
 * never leave the visible area no matter what the renderer asks for.
 * Only ONE display is used: the "home" display (primary, or the one chosen
 * from the tray menu). This is what fixes "invisible on the laptop screen".
 */
const WIN_W = 560;
const WIN_H = 480;
const INSET = 16; // CSS: #stage right/bottom
const PANEL_W = 320;
const PANEL_H = 310; // CSS max-height
const PANEL_GAP = 24;
let panelOpen = false;
let docked = false; // true while hidden at the left edge, peeking
let glideTimer = null;
let glideResolve = null;

function layout() {
  const sc = Math.min(6, Math.max(2, Math.round(Number(config.scale)) || 4));
  const dog = 32 * sc;
  const dogR = WIN_W - INSET;
  const dogB = WIN_H - INSET;
  return {
    dogL: dogR - dog,
    dogR,
    dogT: dogB - dog,
    dogB,
    panelL: dogR - PANEL_W,
    panelT: WIN_H - (dog + PANEL_GAP) - PANEL_H,
  };
}

function homeDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === config.homeDisplayId) || screen.getPrimaryDisplay();
}

// Allowed window x/y range so the DOG (and the panel, when open) stay fully
// inside the home display's work area (i.e. above the taskbar).
function posBounds(withPanel) {
  const wa = homeDisplay().workArea;
  const L = layout();
  let minX = wa.x - L.dogL;
  let maxX = wa.x + wa.width - L.dogR;
  let minY = wa.y - L.dogT;
  let maxY = wa.y + wa.height - L.dogB;
  if (withPanel) {
    minX = Math.max(minX, wa.x - L.panelL);
    minY = Math.max(minY, wa.y - L.panelT);
  }
  if (minX > maxX) minX = maxX;
  if (minY > maxY) minY = maxY;
  return { minX, maxX, minY, maxY };
}

function clampPos(x, y, withPanel = panelOpen) {
  const b = posBounds(withPanel);
  return {
    x: Math.round(Math.min(b.maxX, Math.max(b.minX, Number(x) || 0))),
    y: Math.round(Math.min(b.maxY, Math.max(b.minY, Number(y) || 0))),
  };
}

// setBounds (not setPosition) so Windows DPI rounding can never resize the window.
function moveWindow(x, y) {
  if (!win || win.isDestroyed()) return null;
  const p = clampPos(x, y);
  win.setBounds({ x: p.x, y: p.y, width: WIN_W, height: WIN_H });
  return p;
}

// Where the window sits when the dog is hidden at the LEFT edge (only a
// sliver of the dog shows) and where it sits when popped out.
function dockGeometry() {
  const wa = homeDisplay().workArea;
  const L = layout();
  const b = posBounds(false);
  const dogW = L.dogR - L.dogL;
  const sliver = Math.min(dogW - 8, Math.max(16, Number(config.dockPeekPx) || 44));
  const cy = win && !win.isDestroyed() ? win.getPosition()[1] : b.maxY;
  const y = Math.round(Math.min(b.maxY, Math.max(b.minY, cy)));
  return {
    peekX: Math.round(wa.x - L.dogL - dogW + sliver),
    outX: Math.round(wa.x + 24 - L.dogL),
    y,
  };
}

function cancelGlide() {
  if (glideTimer) {
    clearInterval(glideTimer);
    glideTimer = null;
  }
  if (glideResolve) {
    const r = glideResolve;
    glideResolve = null;
    r(false);
  }
}

// Smooth eased window move (used to walk the dog to / from the left edge).
// Raw coordinates on purpose: the peek position is partly off-screen.
function glideTo(ex, ey, ms) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    cancelGlide();
    const [sx, sy] = win.getPosition();
    const t0 = Date.now();
    glideResolve = resolve;
    glideTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return cancelGlide();
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      win.setBounds({
        x: Math.round(sx + (ex - sx) * e),
        y: Math.round(sy + (ey - sy) * e),
        width: WIN_W,
        height: WIN_H,
      });
      if (k >= 1) {
        clearInterval(glideTimer);
        glideTimer = null;
        glideResolve = null;
        if (!docked) savePositionDebounced(ex, ey);
        resolve(true);
      }
    }, 16);
  });
}

// Reset/second-launch/screen-change: bring the dog fully out and tell the renderer.
function forceOut() {
  cancelGlide();
  docked = false;
  if (win && !win.isDestroyed()) win.webContents.send('mochi:dock-state', { state: 'out' });
}

function reclampWindow() {
  if (docked && win && !win.isDestroyed()) {
    const g = dockGeometry();
    win.setBounds({ x: g.peekX, y: g.y, width: WIN_W, height: WIN_H });
    return;
  }
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const p = moveWindow(x, y);
  if (p) savePositionDebounced(p.x, p.y);
}

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
    row[0] = 0;
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
  ihdr[8] = 8;
  ihdr[9] = 6;
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
let windowVisible = true;

function defaultPosition() {
  try {
    const b = posBounds(false);
    return clampPos(b.maxX - 24, b.maxY, false); // bottom-right of the home screen
  } catch {
    return { x: 100, y: 100 };
  }
}

function createWindow() {
  const savedPos = loadPosition();
  const pos = savedPos ? clampPos(savedPos.x, savedPos.y, false) : defaultPosition();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
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
    win.show();
    win.focus();
    win.setAlwaysOnTop(true);
    win.moveTop();
    windowVisible = true;
    refreshTrayMenu();
    console.log('[mochi] window is visible at:', JSON.stringify(win.getBounds()));
    logLine('window shown at ' + JSON.stringify(win.getBounds()));

    if (SMOKE_MODE) {
      setTimeout(async () => {
        try {
          const probe = await win.webContents.executeJavaScript(
            `(() => { const m = window.__mochi; return m ? {
              boot: true,
              dog: !!m.dog, panel: !!m.panel, settings: !!m.settings,
              wander: !!m.wander, effects: !!m.effects,
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

  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const d = e && typeof e.message === 'string' ? e : { level, message, lineNumber: line, sourceId };
    const text = `[renderer-console] ${d.sourceId}:${d.lineNumber} ${d.message}`;
    console.log(text);
    logLine(text);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log(`[renderer-load-failed] ${code} ${desc}`);
    logLine(`[renderer-load-failed] ${code} ${desc}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine(`[render-process-gone] ${JSON.stringify(details)}`);
  });
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
        else win.showInactive();
      },
    },
    {
      label: 'Hide at left edge now',
      click: () => {
        if (win && !win.isDestroyed()) win.webContents.send('mochi:dock-now');
      },
    },
    {
      label: 'Auto-hide at left edge',
      type: 'checkbox',
      checked: config.dockEnabled !== false,
      click: (item) => {
        config = deepMerge(config, { dockEnabled: item.checked });
        persistConfig();
        if (win && !win.isDestroyed()) win.webContents.send('mochi:config-changed', { ...config });
      },
    },
    {
      label: 'Reset position (bring Mochi back)',
      click: () => {
        if (!win) return;
        forceOut();
        const p = defaultPosition();
        moveWindow(p.x, p.y);
        win.show();
        win.setAlwaysOnTop(true);
        win.moveTop();
      },
    },
    {
      label: 'Use the screen my mouse is on',
      click: () => {
        if (!win) return;
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        config = deepMerge(config, { homeDisplayId: d.id });
        persistConfig();
        forceOut();
        const p = defaultPosition();
        moveWindow(p.x, p.y);
        win.show();
        win.setAlwaysOnTop(true);
        win.moveTop();
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

/* ---------------------------------------------------------- global shortcut */

function registerShortcut() {
  try {
    const ok = globalShortcut.register('CmdOrCtrl+Shift+M', () => {
      if (!win) return;
      if (!win.isVisible()) {
        win.show();
        windowVisible = true;
        refreshTrayMenu();
      }
      win.focus();
      win.moveTop();
      win.webContents.send('mochi:toggle-panel');
    });
    if (!ok) console.error('[mochi] global shortcut registration failed');
  } catch (err) {
    console.error('[mochi] globalShortcut error:', err.message);
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
      if (win && !win.isDestroyed()) win.webContents.send('mochi:config-changed', { ...config });
    }
    return { ...config };
  });

  ipcMain.handle('mochi:get-position', () => {
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      return { x, y };
    }
    return loadPosition();
  });

  ipcMain.on('mochi:save-position', (_e, pos) => {
    if (pos && typeof pos === 'object' && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const p = moveWindow(pos.x, pos.y);
      if (p) savePositionDebounced(p.x, p.y);
    }
  });

  // Safe roaming range (window x/y) for the wander controller: dog fully visible.
  ipcMain.handle('mochi:get-dock-geometry', () => dockGeometry());
  ipcMain.handle('mochi:glide', (_e, t) => {
    const x = Number(t && t.x);
    const y = Number(t && t.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const ms = Math.min(6000, Math.max(250, Number(t.ms) || 1000));
    return glideTo(Math.round(x), Math.round(y), ms);
  });
  ipcMain.on('mochi:cancel-glide', () => cancelGlide());
  ipcMain.on('mochi:set-docked', (_e, v) => {
    docked = !!v;
  });
  ipcMain.handle('mochi:get-wander-bounds', () => posBounds(false));

  // Chat panel opened/closed: when opening, nudge the window so the whole panel is visible.
  ipcMain.on('mochi:panel-open', (_e, open) => {
    panelOpen = !!open;
    if (panelOpen && docked) {
      cancelGlide();
      docked = false; // opening chat (e.g. hotkey) while hidden brings the dog out
    }
    if (panelOpen) reclampWindow();
  });

  ipcMain.handle('mochi:get-displays', () => {
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
    }));
  });

  ipcMain.handle('mochi:get-screen-size', () => {
    const primary = screen.getPrimaryDisplay();
    return {
      width: primary.workArea.width,
      height: primary.workArea.height,
    };
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
}

/* --------------------------------------------------------------- lifecycle */

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  screen.on('display-added', reclampWindow);
  screen.on('display-removed', reclampWindow);
  screen.on('display-metrics-changed', reclampWindow);
  createTray();
  registerShortcut();
  applyLoginItemSetting();
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
