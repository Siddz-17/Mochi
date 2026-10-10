/**
 * boot.js — Mochi renderer composition root (pixel-sprite dog edition).
 *
 * Wires the sprite canvas dog, overlay effects, screen wanderer,
 * speech-bubble chat panel, and minimal settings modal together.
 */

import { loadSprites } from './spriteLoader.js';
import { createEffects } from './effects.js';
import { createDog } from './dog.js';
import { createPanel } from './panel.js';
import { createSettings } from './settings.js';
import { createWander } from './wander.js';
import { createDock } from './dock.js';
import * as registry from '../provider/registry.js';

const bridge = window.mochi;

let config = {
  provider: 'mock',
  scale: 4,
  userName: '',
  wanderEnabled: true,
  calmMode: false,
  sleepAfterMinutes: 5,
};

let dog = null;
let panel = null;
let settings = null;
let wander = null;
let dock = null;
let effects = null;

const getConfig = () => ({ ...config });

function applyConfig(cfg) {
  if (!cfg) return;
  config = { ...config, ...cfg };

  if (dog) {
    if (config.scale) dog.setScale(config.scale);
    if (typeof config.calmMode === 'boolean') dog.setCalmMode(config.calmMode);
  }

  if (wander) {
    if (config.wanderEnabled === false) {
      wander.stop();
    } else {
      wander.start();
    }
  }
}

async function boot() {
  if (!bridge) {
    console.error('[mochi] preload bridge window.mochi is missing');
    return;
  }

  try {
    const remoteConfig = await bridge.getConfig();
    if (remoteConfig && typeof remoteConfig === 'object') {
      config = { ...config, ...remoteConfig };
    }
  } catch (err) {
    console.warn('[mochi] failed to load initial config:', err);
  }

  const canvasEl = document.getElementById('dog-canvas');
  if (!canvasEl) {
    console.error('[mochi] #dog-canvas not found in DOM');
    return;
  }

  // Load pixel sprites
  let sprites = null;
  try {
    sprites = await loadSprites();
  } catch (err) {
    console.error('[mochi] failed to load sprites:', err);
  }

  // Create overlay effects
  const layerEl = document.getElementById('effects-layer');
  if (layerEl && sprites) {
    effects = createEffects(layerEl, sprites);
    if (typeof effects.setScale === 'function') {
      effects.setScale(config.scale || 4);
    }
  }

  // Create sprite dog engine
  dog = createDog(canvasEl, {
    bridge,
    effects,
    sprites,
    getScale: () => config.scale || 4,
    sleepAfterMinutes: config.sleepAfterMinutes || 5,
    onPanelToggleRequest: () => {
      // First click on a hidden (peeking) dog only pops it out; chat opens on the next click.
      if (dock && dock.handleClick()) return;
      if (panel) panel.toggle();
    },
    onDragStart: () => { if (dock) dock.noteDragStart(); },
    onDragEnd: () => { if (dock) dock.noteDragEnd(); },
  });

  // Create chat panel
  const panelEl = document.getElementById('panel');
  panel = createPanel(panelEl, {
    registry,
    bridge,
    dog,
    getConfig,
  });

  // Create settings
  const settingsEl = document.getElementById('settings');
  settings = createSettings(settingsEl, {
    bridge,
    dog,
    getConfig,
  });

  // Create wanderer
  wander = createWander({
    bridge,
    dog,
    getConfig,
  });

  // Hide-at-left-edge behaviour (20s idle -> peek; click -> pop out; click again -> chat).
  dock = createDock({ bridge, dog, wander, panel, getConfig });

  // Never wander while the chat panel is open.
  window.addEventListener('mochi:panel', (e) => {
    if (!wander) return;
    if (e.detail && e.detail.open) wander.pause();
    else wander.resume();
  });

  // Initial config application
  applyConfig(config);

  // Listen for config changes from main
  if (typeof bridge.onConfigChanged === 'function') {
    bridge.onConfigChanged((newCfg) => {
      applyConfig(newCfg);
    });
  }

  // Sleep toggle from tray
  if (typeof bridge.onSleepToggle === 'function') {
    bridge.onSleepToggle(({ sleeping }) => {
      if (dog) {
        if (sleeping) dog.sleep();
        else dog.wake();
      }
      if (wander) {
        if (sleeping) wander.pause();
        else wander.resume();
      }
    });
  }

  // Expose for testing and debugging
  window.__mochi = {
    boot: true,
    dog,
    panel,
    settings,
    wander,
    dock,
    effects,
    getConfig,
  };

  console.log('[mochi] sprite renderer boot complete');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
