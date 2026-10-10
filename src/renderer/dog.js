/**
 * dog.js — Mochi pixel-dog companion engine (sprite-based).
 *
 * Renders hand-crafted 32x32 pixel sprites on a 2D canvas with crisp pixelation.
 * Supports idle life actions, cursor eye-following, petting, dragging with dangle/bounce,
 * screen wandering walk cycles, and chatbot reactions.
 */

import { loadSprites } from './spriteLoader.js';
import { MochiState } from '../state/mochiState.js';

const TILE = 32;
const MIN_SCALE = 2;
const MAX_SCALE = 6;
const DEFAULTS = { scale: 4, sleepAfterMinutes: 5, calmMode: false };

const LOOK_ANIMS = ['look-left', 'look-right', 'look-up', 'look-down'];
const AGENT_EFFECTS = ['ellipsis', 'exclaim', 'sparkle', 'sweat'];

function clampInt(n, lo, hi) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

export function createDog(canvas, opts = {}) {
  if (!canvas) throw new Error('[mochi] createDog requires a canvas element');
  const bridge = opts.bridge || {};
  const effects = opts.effects || null;
  const onPanelToggleRequest =
    typeof opts.onPanelToggleRequest === 'function' ? opts.onPanelToggleRequest : () => {};

  let config = { ...DEFAULTS };
  let sprites = opts.sprites || null;
  let scale = DEFAULTS.scale;
  try {
    const s = opts.getScale ? opts.getScale() : null;
    if (Number.isFinite(s)) scale = clampInt(s, MIN_SCALE, MAX_SCALE) || DEFAULTS.scale;
  } catch {}

  let mode = 'idle'; // idle | sleep | drag
  let agentState = MochiState.IDLE;
  let agentToken = 0;
  let destroyed = false;
  let panelOpen = false;

  let player = { name: null, index: 0, loop: true, onDone: null };
  let frameTimer = null;
  const timers = new Set();
  let idleActionT = null;
  let blinkT = null;
  let sleepT = null;
  let dotsI = null;

  let tiltX = 0;
  let looking = null;
  let lastLookT = 0;
  let lastMouse = null;
  let lastMove = null;
  let barkReadyAt = 0;
  let petReadyAt = 0;
  let petHits = [];
  let pressInfo = null;
  let dragging = false;
  let lastDragSave = 0;
  let lastToggleTime = 0;
  let isWalkingManually = false;

  const ctx = canvas.getContext('2d');
  const alphaCanvas = document.createElement('canvas');
  alphaCanvas.width = TILE;
  alphaCanvas.height = TILE;
  let actx = null;
  try {
    actx = alphaCanvas.getContext('2d', { willReadFrequently: true });
  } catch {
    actx = alphaCanvas.getContext('2d');
  }
  let alphaData = null;

  const layerEl = document.getElementById('effects-layer');
  const dotsEl = document.createElement('div');
  dotsEl.className = 'mochi-dots';

  const disposers = [];
  const on = (target, ev, fn, o) => {
    target.addEventListener(ev, fn, o);
    disposers.push(() => target.removeEventListener(ev, fn, o));
  };

  function later(fn, ms) {
    if (destroyed) return null;
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
    return id;
  }

  async function loadConfig() {
    try {
      const c = await bridge.getConfig();
      if (c && typeof c === 'object') config = { ...config, ...c };
    } catch {}
    try {
      const s = opts.getScale ? opts.getScale() : null;
      if (Number.isFinite(s)) {
        const n = clampInt(s, MIN_SCALE, MAX_SCALE);
        if (n) config.scale = n;
      }
    } catch {}
  }

  function isCalm() {
    if (config.calmMode) return true;
    try {
      return (
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch {
      return false;
    }
  }

  // Animation player
  function getAnim(name) {
    const anims = sprites && sprites.map && sprites.map.animations;
    const a = anims && anims[name];
    if (a && Array.isArray(a.frames) && a.frames.length) return a;
    const fb = anims && anims['idle-sit'];
    if (fb && Array.isArray(fb.frames) && fb.frames.length) return fb;
    return { frames: [{ x: 0, y: 0, w: TILE, h: TILE, durationMs: 120 }] };
  }

  function drawCurrentFrame() {
    if (!sprites || !sprites.img) return;
    const anim = getAnim(player.name || 'idle-sit');
    const f = anim.frames[player.index] || anim.frames[0];
    const s = scale;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprites.img, f.x, f.y, f.w, f.h, tiltX, 0, f.w * s, f.h * s);
    if (actx) {
      actx.clearRect(0, 0, TILE, TILE);
      actx.drawImage(sprites.img, f.x, f.y, f.w, f.h, 0, 0, TILE, TILE);
      try {
        alphaData = actx.getImageData(0, 0, TILE, TILE).data;
      } catch {
        alphaData = null;
      }
    }
  }

  function stopPlayer() {
    if (frameTimer) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
  }

  function advanceFrame() {
    stopPlayer();
    if (destroyed || !sprites || !player.name) return;
    drawCurrentFrame();
    if (lastMouse) updateClickThrough(lastMouse.x, lastMouse.y);
    const anim = getAnim(player.name);
    const frame = anim.frames[player.index] || anim.frames[0];
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (destroyed) return;
      player.index += 1;
      if (player.index >= anim.frames.length) {
        if (player.loop) {
          player.index = 0;
        } else {
          const cb = player.onDone;
          player.onDone = null;
          if (cb) cb();
          return;
        }
      }
      advanceFrame();
    }, Math.max(16, frame.durationMs || 120));
  }

  function startAnim(name, loop, onDone) {
    player = { name, index: 0, loop: !!loop, onDone: onDone || null };
    advanceFrame();
  }
  const playLoop = (name) => startAnim(name, true, null);
  const playOnce = (name, onDone) => startAnim(name, false, onDone);

  const lifeActive = () =>
    !destroyed && mode === 'idle' && agentState === MochiState.IDLE && !panelOpen && !isWalkingManually;

  function settleIdle() {
    if (destroyed || mode !== 'idle') return;
    tiltX = 0;
    looking = null;
    playLoop('idle-sit');
    scheduleIdleAction();
    scheduleBlink();
  }

  function scheduleIdleAction() {
    if (idleActionT) {
      clearTimeout(idleActionT);
      timers.delete(idleActionT);
      idleActionT = null;
    }
    if (destroyed) return;
    const lo = 3500, hi = 9000;
    idleActionT = later(doIdleAction, lo + Math.random() * (hi - lo));
  }

  function doIdleAction() {
    idleActionT = null;
    if (!lifeActive()) return;
    const calm = isCalm();
    const r = Math.random();
    if (r < 0.22) playOnce('ear-twitch', settleIdle);
    else if (r < 0.42) playOnce('tail-wag', settleIdle);
    else if (r < 0.60) lookAround();
    else if (r < 0.70 && !calm) playOnce('scratch', settleIdle);
    else if (r < 0.80 && !calm) playOnce('yawn', settleIdle);
    else if (r < 0.88 && !calm) playOnce('stretch', settleIdle);
    else if (r < 0.94 && !calm) doWalkWobble();
    else if (!calm) playOnce('tail-wag', settleIdle);
    else settleIdle();
  }

  function lookAround() {
    if (!lifeActive()) return;
    const anim = LOOK_ANIMS[(Math.random() * LOOK_ANIMS.length) | 0];
    playOnce(anim, settleIdle);
  }

  function doWalkWobble() {
    if (!lifeActive()) return;
    const dir = Math.random() < 0.5 ? 'walk-left' : 'walk-right';
    playLoop(dir);
    [1, -1, 1, 0].forEach((o, i) => {
      later(() => {
        if (lifeActive()) tiltX = o * scale;
      }, i * 300);
    });
    later(() => {
      if (mode === 'idle') {
        tiltX = 0;
        settleIdle();
      }
    }, 1300);
  }

  function clearBlink() {
    if (blinkT) {
      clearTimeout(blinkT);
      timers.delete(blinkT);
      blinkT = null;
    }
  }

  function scheduleBlink() {
    if (blinkT || destroyed) return;
    const calm = isCalm();
    const ms = calm ? 6000 + Math.random() * 4000 : 3000 + Math.random() * 3000;
    blinkT = later(() => {
      blinkT = null;
      if (lifeActive() && player.name === 'idle-sit') {
        playOnce('blink', () => {
          if (lifeActive() && mode === 'idle') playLoop('idle-sit');
        });
      }
      scheduleBlink();
    }, ms);
  }

  // Sleep / Inactivity
  function resetSleepTimer() {
    if (sleepT) {
      clearTimeout(sleepT);
      timers.delete(sleepT);
      sleepT = null;
    }
    if (destroyed || mode === 'sleep') return;
    if (agentState !== MochiState.IDLE) return;
    const mins = Math.max(0.05, Number(config.sleepAfterMinutes) || DEFAULTS.sleepAfterMinutes);
    sleepT = later(() => {
      sleepT = null;
      sleep();
    }, mins * 60000);
  }

  function poke() {
    if (destroyed) return;
    if (mode === 'sleep') {
      wake();
      return;
    }
    resetSleepTimer();
  }

  function sleep() {
    if (mode === 'peek') return; // never fall asleep while hidden at the edge
    if (destroyed || mode === 'sleep' || mode === 'drag') return;
    clearAgentVisuals();
    mode = 'sleep';
    if (idleActionT) {
      clearTimeout(idleActionT);
      timers.delete(idleActionT);
      idleActionT = null;
    }
    clearBlink();
    if (sleepT) {
      clearTimeout(sleepT);
      timers.delete(sleepT);
      sleepT = null;
    }
    stopPlayer();
    player = { name: 'sleep', index: 0, loop: false, onDone: null };
    drawCurrentFrame();
    if (effects) {
      const p = effectXY('zzz');
      effects.show('zzz', {
        x: Math.min(p.x + 10 * scale, canvas.width - 8 * scale),
        y: 0,
        static: true,
      });
    }
  }

  function wake() {
    if (destroyed || mode !== 'sleep') return;
    if (effects) effects.clear('zzz');
    loadConfig();
    mode = 'idle';
    playOnce('wake', settleIdle);
    resetSleepTimer();
  }

  // Agent reactions
  function effectXY(name) {
    const fx = sprites && sprites.map && sprites.map.effects && sprites.map.effects[name];
    const f = fx && fx.frames && fx.frames[0];
    const ew = f ? f.w * scale : 16;
    return { x: Math.round((canvas.width - ew) / 2) };
  }

  function showDots() {
    hideDots();
    if (!layerEl) return;
    if (!dotsEl.parentElement) layerEl.appendChild(dotsEl);
    dotsEl.style.display = 'block';
    const frames = ['.  ', '.. ', '...'];
    let i = 0;
    const tick = () => {
      dotsEl.textContent = frames[i++ % frames.length];
    };
    tick();
    dotsI = setInterval(tick, 450);
  }

  function hideDots() {
    if (dotsI) {
      clearInterval(dotsI);
      dotsI = null;
    }
    dotsEl.style.display = 'none';
  }

  function clearAgentVisuals() {
    if (effects) for (const n of AGENT_EFFECTS) effects.clear(n);
    hideDots();
  }

  function setAgentState(state) {
    const tok = ++agentToken;
    agentState = state || MochiState.IDLE;
    clearAgentVisuals();
    if (destroyed) return;
    if (mode === 'sleep') wake();
    if (idleActionT) {
      clearTimeout(idleActionT);
      timers.delete(idleActionT);
      idleActionT = null;
    }
    clearBlink();
    stopPlayer();

    switch (agentState) {
      case MochiState.THINKING:
        playLoop('think');
        if (effects) effects.show('ellipsis', { x: effectXY('ellipsis').x, y: 2, loop: true });
        break;
      case MochiState.DONE:
        if (isCalm()) {
          playLoop('idle-sit');
        } else {
          playOnce('hop', () => {
            if (agentToken === tok) playLoop('idle-sit');
          });
        }
        if (effects) effects.show('sparkle', { x: effectXY('sparkle').x, y: 14, ms: 1600 });
        later(() => {
          if (agentToken === tok) setAgentState(MochiState.IDLE);
        }, 1600);
        break;
      case MochiState.ERROR:
        playLoop('sad');
        if (effects) effects.show('sweat', { x: effectXY('sweat').x, y: 4, loop: true });
        later(() => {
          if (agentToken === tok) setAgentState(MochiState.IDLE);
        }, 3000);
        break;
      default:
        agentState = MochiState.IDLE;
        if (mode === 'idle') settleIdle();
    }
    resetSleepTimer();
  }

  // Click-through hit-testing
  function isOverInteractiveUI(clientX, clientY) {
    const panelEl = document.getElementById('panel');
    if (panelEl && !panelEl.hidden && !panelEl.classList.contains('hidden')) {
      const pr = panelEl.getBoundingClientRect();
      if (clientX >= pr.left && clientX <= pr.right && clientY >= pr.top && clientY <= pr.bottom) {
        return true;
      }
    }
    const settingsEl = document.getElementById('settings');
    if (settingsEl && settingsEl.classList.contains('mset-open')) {
      return true;
    }
    return false;
  }

  function alphaAt(sx, sy) {
    if (!alphaData || sx < 0 || sy < 0 || sx >= TILE || sy >= TILE) return 0;
    return alphaData[(sy * TILE + sx) * 4 + 3];
  }

  function updateClickThrough(clientX, clientY) {
    if (dragging || destroyed) return;
    if (typeof bridge.setIgnoreMouseEvents !== 'function') return;
    if (isOverInteractiveUI(clientX, clientY)) {
      try {
        bridge.setIgnoreMouseEvents(false);
      } catch {}
      return;
    }
    const r = canvas.getBoundingClientRect();
    const sx = Math.floor((clientX - r.left) / scale);
    const sy = Math.floor((clientY - r.top) / scale);
    const transparent = alphaAt(sx, sy) < 8;
    try {
      bridge.setIgnoreMouseEvents(transparent, { forward: true });
    } catch {}
  }

  // Mouse interactions
  function distToCenter(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
  }

  function toSource(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor((clientX - r.left) / scale),
      y: Math.floor((clientY - r.top) / scale),
    };
  }

  function eyeFollow(e) {
    if (!lifeActive()) return;
    const r = canvas.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < 14) {
      if (looking) {
        looking = null;
        playLoop('idle-sit');
      }
      return;
    }
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const dir =
      ang >= -45 && ang < 45
        ? 'look-right'
        : ang >= 45 && ang < 135
        ? 'look-down'
        : ang >= -135 && ang < -45
        ? 'look-up'
        : 'look-left';
    const now = Date.now();
    if (dir !== looking && now - lastLookT > 600) {
      looking = dir;
      lastLookT = now;
      playOnce(dir, settleIdle);
    }
  }

  function doPet() {
    if (!lifeActive()) return;
    playOnce('pet-squint', () => {
      if (lifeActive()) playOnce('happy', settleIdle);
      else settleIdle();
    });
    if (effects) effects.show('heart', { x: effectXY('heart').x, y: 6, ms: 1500 });
  }

  function onMouseMove(e) {
    if (destroyed) return;
    const now = Date.now();
    lastMouse = { x: e.clientX, y: e.clientY };

    if (pressInfo) {
      handleDragMove(e);
      if (dragging) return;
    }
    if (mode === 'sleep') {
      if (distToCenter(e.clientX, e.clientY) < 120) wake();
      return;
    }

    poke();
    updateClickThrough(e.clientX, e.clientY);

    // Fast cursor movement perk-up
    if (lastMove) {
      const dt = now - lastMove.t;
      if (dt > 0) {
        const v = (Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / dt) * 1000;
        if (v > 1600 && now > barkReadyAt && lifeActive() && !isCalm()) {
          barkReadyAt = now + 10000;
          playOnce('alert-bark', settleIdle);
        }
      }
    }
    lastMove = { t: now, x: e.clientX, y: e.clientY };

    // Petting head region
    const s = toSource(e.clientX, e.clientY);
    if (s.x >= 9 && s.x <= 23 && s.y >= 1 && s.y <= 13) {
      petHits.push(now);
      petHits = petHits.filter((t) => now - t < 600);
      if (petHits.length >= 6 && now > petReadyAt && lifeActive()) {
        petReadyAt = now + 6000;
        petHits = [];
        doPet();
      }
    }

    eyeFollow(e);
  }

  function onMouseEnter() {
    if (!lifeActive()) return;
    tiltX = scale;
    playOnce('ear-twitch', () => {
      tiltX = 0;
      if (lifeActive()) settleIdle();
    });
  }

  function onMouseLeave() {
    tiltX = 0;
  }

  // Drag & Click
  async function windowPosition() {
    try {
      const p = await bridge.getPosition();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch {}
    return { x: 0, y: 0 };
  }

  async function onMouseDown(e) {
    if (destroyed || e.button !== 0) return;
    if (mode === 'sleep') {
      wake();
      return;
    }
    poke();
    const pos = await windowPosition();
    pressInfo = {
      t: Date.now(),
      sx: e.screenX,
      sy: e.screenY,
      dx: e.screenX - pos.x,
      dy: e.screenY - pos.y,
    };
    try {
      if (e.pointerId != null && canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    } catch {}
  }

  function handleDragMove(e) {
    const p = pressInfo;
    if (!p || destroyed) return;
    if (!dragging && Math.hypot(e.screenX - p.sx, e.screenY - p.sy) > 5) {
      try { if (typeof opts.onDragStart === 'function') opts.onDragStart(); } catch {}
      dragging = true;
      mode = 'drag';
      if (idleActionT) {
        clearTimeout(idleActionT);
        timers.delete(idleActionT);
        idleActionT = null;
      }
      clearBlink();
      if (sleepT) {
        clearTimeout(sleepT);
        timers.delete(sleepT);
        sleepT = null;
      }
      stopPlayer();
      playLoop('drag-dangle');
      try {
        bridge.setIgnoreMouseEvents(false);
      } catch {}
    }
    if (dragging) {
      const now = Date.now();
      if (now - lastDragSave > 16) {
        lastDragSave = now;
        try {
          bridge.savePosition(Math.round(e.screenX - p.dx), Math.round(e.screenY - p.dy));
        } catch {}
      }
    }
  }

  function onMouseUp(e) {
    if (!pressInfo) return;
    const p = pressInfo;
    pressInfo = null;
    if (destroyed) {
      dragging = false;
      return;
    }
    const dt = Date.now() - p.t;
    const moved = Math.hypot(e.screenX - p.sx, e.screenY - p.sy);
    if (dragging) {
      dragging = false;
      try {
        bridge.savePosition(Math.round(e.screenX - p.dx), Math.round(e.screenY - p.dy));
      } catch {}
      mode = 'idle';
      try { if (typeof opts.onDragEnd === 'function') opts.onDragEnd(); } catch {}
      playOnce('drop-bounce', settleIdle);
      resetSleepTimer();
    } else if (dt < 600 && moved < 8) {
      lastToggleTime = Date.now();
      loadConfig();
      try {
        onPanelToggleRequest();
      } catch {}
    }
  }

  // Wandering walk cycles
  function startWalk(direction) {
    if (destroyed || mode === 'drag' || mode === 'sleep') return;
    isWalkingManually = true;
    const anim = direction === 'left' ? 'walk-left' : 'walk-right';
    playLoop(anim);
  }

  function stopWalk() {
    if (destroyed || mode === 'drag' || mode === 'sleep') return;
    isWalkingManually = false;
    settleIdle();
  }

  // Hidden at the screen edge, peeking: hold the 'peek' loop, no idle actions.
  function setDocked(on_) {
    if (destroyed) return;
    if (on_) {
      if (mode === 'sleep') mode = 'idle';
      mode = 'peek';
      isWalkingManually = false;
      for (const t of [idleActionT, blinkT, sleepT]) {
        if (t) { clearTimeout(t); timers.delete(t); }
      }
      idleActionT = null;
      blinkT = null;
      sleepT = null;
      stopPlayer();
      playLoop('peek');
    } else if (mode === 'peek' || mode === 'sleep') {
      mode = 'idle';
      isWalkingManually = false;
      settleIdle();
      resetSleepTimer();
    }
  }

  function setPanelOpen(on_) {
    panelOpen = !!on_;
    if (panelOpen) {
      if (mode === 'sleep') wake();
      settleIdle();
    }
  }

  function setCalmMode(on_) {
    config.calmMode = !!on_;
  }

  // Scale & sizing
  function sizeCanvas() {
    canvas.width = TILE * scale;
    canvas.height = TILE * scale;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    canvas.style.imageRendering = 'pixelated';
    const stageEl = document.getElementById('stage');
    if (stageEl) {
      stageEl.style.width = `${canvas.width}px`;
      stageEl.style.height = `${canvas.height}px`;
    }
    const panelEl = document.getElementById('panel');
    if (panelEl) {
      panelEl.style.bottom = `${canvas.height + 28}px`;
    }
  }

  function setScale(n) {
    const nn = clampInt(n, MIN_SCALE, MAX_SCALE);
    if (!nn || nn === scale) return;
    scale = nn;
    sizeCanvas();
    drawCurrentFrame();
    if (effects && typeof effects.setScale === 'function') effects.setScale(nn);
    if (lastMouse) updateClickThrough(lastMouse.x, lastMouse.y);
  }

  function setSize(px) {
    const s = Math.round(Number(px) / TILE);
    setScale(s);
  }

  function onVisibilityChange() {
    if (destroyed) return;
    if (document.hidden) {
      stopPlayer();
      if (idleActionT) {
        clearTimeout(idleActionT);
        timers.delete(idleActionT);
        idleActionT = null;
      }
      clearBlink();
    } else {
      if (mode === 'sleep') {
        drawCurrentFrame();
        return;
      }
      advanceFrame();
      if (mode === 'idle' && agentState === MochiState.IDLE) {
        scheduleIdleAction();
        scheduleBlink();
      }
    }
  }

  function destroy() {
    destroyed = true;
    for (const d of disposers.splice(0)) {
      try {
        d();
      } catch {}
    }
    for (const id of [...timers]) {
      clearTimeout(id);
      timers.delete(id);
    }
    stopPlayer();
    if (dotsI) {
      clearInterval(dotsI);
      dotsI = null;
    }
    if (effects) effects.clearAll();
    try {
      dotsEl.remove();
    } catch {}
    try {
      bridge.setIgnoreMouseEvents(false);
    } catch {}
  }

  function wireEvents() {
    on(window, 'mousemove', onMouseMove);
    on(window, 'mouseup', onMouseUp);
    on(canvas, 'mouseenter', onMouseEnter);
    on(canvas, 'mouseleave', onMouseLeave);
    on(canvas, 'mousedown', onMouseDown);
    on(canvas, 'click', (e) => {
      e.stopPropagation();
      if (dragging) return;
      if (Date.now() - lastToggleTime < 300) return;
      lastToggleTime = Date.now();
      loadConfig();
      try {
        onPanelToggleRequest();
      } catch {}
    });
    on(document, 'visibilitychange', onVisibilityChange);
    try {
      if (typeof bridge.onSleepToggle === 'function') {
        bridge.onSleepToggle((v) => {
          const toSleep =
            typeof v === 'boolean'
              ? v
              : v && typeof v.sleeping === 'boolean'
              ? v.sleeping
              : mode !== 'sleep';
          if (toSleep) sleep();
          else wake();
        });
      }
    } catch {}
  }

  async function init() {
    sizeCanvas();
    wireEvents();
    await loadConfig();
    const cs = clampInt(config.scale, MIN_SCALE, MAX_SCALE);
    if (cs && cs !== scale) {
      scale = cs;
      sizeCanvas();
    }
    if (!sprites) {
      try {
        sprites = await loadSprites();
      } catch (err) {
        console.error('[mochi] sprite load failed:', err);
        return;
      }
    }
    if (effects && typeof effects.setScale === 'function') effects.setScale(scale);
    settleIdle();
    scheduleBlink();
    resetSleepTimer();
  }
  init();

  return {
    setAgentState,
    setScale,
    setSize,
    setCalmMode,
    startWalk,
    stopWalk,
    setPanelOpen,
    setDocked,
    sleep,
    wake,
    destroy,
  };
}
