/**
 * boot.js — Mochi renderer composition root.
 *
 * Written by the build coordinator. Instantiates every module and wires them
 * together; no app logic lives here beyond composition.
 *
 * Wiring order:
 *   config -> sprites -> effects -> sound -> dog -> panel -> settings
 *   -> pomodoro / reminders
 *
 * Contracts honored:
 * - createDog(canvas, {bridge, effects, sprites, getScale, onPanelToggleRequest})
 * - createEffects(layerEl, sprites) -> {show, clear, clearAll, setScale, ...}
 * - createPanel(panelEl, {registry, bridge, dog, getConfig})
 * - createSettings(settingsEl, {bridge, dog, getConfig})
 * - createPomodoro({bridge, effects, dog, getConfig, sound})
 * - createReminders({bridge, effects, getConfig, sound})
 * - createSound() -> {setEnabled, bark, pant, pop}
 * Panel self-wires bridge.onTogglePanel; settings self-wires
 * bridge.onOpenSettings; dog self-wires bridge.onSleepToggle.
 */

import { loadSprites } from './spriteLoader.js';
import { createEffects } from './effects.js';
import { createDog } from './dog.js';
import { createPanel } from './panel.js';
import { createSettings } from './settings.js';
import * as registry from '../provider/registry.js';
import { createPomodoro } from '../extras/pomodoro.js';
import { createReminders } from '../extras/reminders.js';
import { createSound } from '../extras/sound.js';

const bridge = window.mochi;

let config = {};
let currentScale = 4;
let dog = null;
let sound = null;

const getConfig = () => ({ ...config });

function clampScale(n) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(6, Math.max(2, n)) : 4;
}

/** Apply live config values to running modules. */
function applyConfig() {
  const s = clampScale(config.scale);
  if (dog && s !== currentScale) {
    currentScale = s;
    try {
      dog.setScale(s);
    } catch (e) {
      console.warn('[mochi] setScale failed:', e);
    }
  }
  if (sound) {
    try {
      sound.setEnabled(!!config.soundsEnabled);
    } catch (e) {
      console.warn('[mochi] sound.setEnabled failed:', e);
    }
  }
  if (dog && typeof dog.setPeekMode === 'function') {
    try {
      dog.setPeekMode(!!config.peekMode);
    } catch (e) {
      console.warn('[mochi] setPeekMode failed:', e);
    }
  }
}

async function refreshConfig() {
  try {
    const c = await bridge.getConfig();
    if (c && typeof c === 'object') config = c;
  } catch (e) {
    console.warn('[mochi] getConfig failed:', e);
  }
}

async function boot() {
  if (!bridge) throw new Error('[mochi] preload bridge window.mochi is missing');

  await refreshConfig();
  currentScale = clampScale(config.scale);

  const sprites = await loadSprites();

  const layerEl = document.getElementById('effects-layer');
  const effects = createEffects(layerEl, sprites);
  if (typeof effects.setScale === 'function') effects.setScale(currentScale);

  sound = createSound();

  // Panel is created after the dog, so the click callback closes over `let`.
  let panel = null;
  dog = createDog(document.getElementById('dog-canvas'), {
    bridge,
    effects,
    sprites,
    getScale: () => currentScale,
    onPanelToggleRequest: () => {
      if (panel) panel.toggle();
    },
  });

  panel = createPanel(document.getElementById('panel'), {
    registry,
    bridge,
    dog,
    getConfig,
  });

  // First-run onboarding bubble (Phase C). Dynamic import + try/catch so a
  // failure here can never break boot.
  try {
    const { maybeShowOnboarding } = await import('./onboarding.js');
    window.__mochiOnboarding = maybeShowOnboarding({ bridge, getConfig, dog });
  } catch (e) {
    console.warn('[mochi] onboarding failed:', e);
  }

  const settings = createSettings(document.getElementById('settings'), {
    bridge,
    dog,
    getConfig,
  });

  // Live config updates: main broadcasts 'mochi:config-changed' whenever
  // setConfig persists (Settings saves through bridge.setConfig, which we
  // cannot intercept — contextBridge freezes the bridge object).
  // Fall back to polling only if the event is unavailable.
  if (bridge && typeof bridge.onConfigChanged === 'function') {
    bridge.onConfigChanged((next) => {
      if (next && typeof next === 'object') {
        config = next;
        applyConfig();
      } else {
        refreshConfig().then(applyConfig);
      }
    });
  } else {
    setInterval(async () => {
      const before = JSON.stringify(config);
      await refreshConfig();
      if (JSON.stringify(config) !== before) applyConfig();
    }, 5000);
  }

  const pomodoro = createPomodoro({ bridge, effects, dog, getConfig, sound });
  const reminders = createReminders({ bridge, effects, getConfig, sound });
  try {
    reminders.start();
  } catch (e) {
    console.warn('[mochi] reminders.start failed:', e);
  }
  if (config.pomodoro && config.pomodoro.enabled) {
    try {
      pomodoro.start();
    } catch (e) {
      console.warn('[mochi] pomodoro autostart failed:', e);
    }
  }

  applyConfig();

  // Debug / smoke-test handle.
  window.__mochi = {
    version: '0.1.0',
    dog,
    panel,
    settings,
    effects,
    pomodoro,
    reminders,
    sound,
    getConfig,
  };
  console.log('[mochi] boot complete');
}

boot().catch((e) => console.error('[mochi] boot failed:', e));
