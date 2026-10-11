/**
 * dog.js — Mochi "dog life" renderer (the pixel-dog companion engine).
 *
 * ============================================================================
 * PUBLIC API
 * ============================================================================
 *   import { createDog } from './dog.js';
 *
 *   const dog = createDog(canvas, opts);
 *     canvas : the #dog-canvas <canvas> element (32x32 source frames).
 *     opts   : {
 *       bridge,                // window.mochi bridge (preload)
 *       effects,               // handle from createEffects(#effects-layer, sprites)
 *       onPanelToggleRequest,  // () => void — called on a clean click on the dog
 *       getScale,              // () => number — initial integer scale (2..6)
 *       sprites,               // optional shared { img, map } to avoid double load
 *     }
 *
 *   dog -> {
 *     setAgentState(state),  // MochiState value: idle/thinking/working/
 *                            //   needs-approval/done/error
 *     setScale(n),           // integer 2..6; resizes canvas, keeps pixels crisp
 *     setPeekMode(on),       // slide dog to the screen edge; peek frames only
 *     setUiOverlay(on),      // a window-level UI bubble (e.g. onboarding) is
 *                            //   up: hover antics quiet down, the window stays
 *                            //   mouse-active so the bubble is clickable
 *     sleep(),               // enter sleep (static frame + zzz, timers paused)
 *     wake(),                // play `wake`, resume normal life
 *     destroy(),             // remove listeners, clear timers/effects
 *   }
 *
 * Life state machine: idle (base loop `idle-sit`), with one-shot actions
 * blink / ear-twitch / tail-wag / look-around / scratch / yawn / stretch /
 * sneeze / shake / tail-chase / walk, plus `sleep`, `drag`, and `peek`
 * modes. Animation switches crossfade over ~150ms (alpha composite, no
 * smoothing). Agent states (thinking, working, needs-approval, done, error)
 * temporarily take over the player and pause the life loop; returning to
 * idle resumes normal life.
 *
 * Wander (optional): when config.wanderEnabled === true, the dog every few
 * minutes glides to a nearby on-screen spot (walk animation, eased 1.4s
 * window move via bridge.savePosition, clamped to window.screen's available
 * area). Aborts on any user/agent/mode change; never runs in calm mode.
 *
 * MochiState is imported from ../../state/mochiState.js with a defensive
 * dynamic import — if that module is missing, a local fallback enum is used.
 *
 * ============================================================================
 * CONFIG (via bridge.getConfig(), may be sync or async)
 * ============================================================================
 *   { scale: 4, sleepAfterMinutes: 5, calmMode: false, wanderEnabled: false }
 * Calm mode (or OS prefers-reduced-motion): no hop/walk/yawn/stretch, slower
 * blink, no sudden alert-bark.
 *
 * ============================================================================
 * ASSUMPTIONS / CONTRACT NOTES for the coordinator (boot.js) and main agent
 * ============================================================================
 * 1. DRAG: main owns the window position. On drag we compute the new x/y from
 *    the cursor and call bridge.savePosition(x, y) (throttled ~60Hz). The main
 *    process handler for savePosition MUST also call win.setPosition(x, y) —
 *    persisting alone will not move the window.
 * 2. CLICK-THROUGH: we hit-test the current frame's alpha and call
 *    bridge.setIgnoreMouseEvents(transparentPixel). For hover/eye-follow to
 *    keep working over transparent pixels, preload should forward mouse
 *    events: win.setIgnoreMouseEvents(ignore, { forward: true }).
 * 3. bridge.getPosition() / bridge.getConfig() may return a value or a
 *    Promise — both are handled.
 * 4. bridge.onSleepToggle(cb): cb receives `{ sleeping: boolean }` from the
 *    tray menu (a bare boolean is also accepted; anything else toggles).
 * 5. #effects-layer must be positioned over #dog-canvas (see styles.css) and
 *    #panel-badge hidden by default (shown on needs-approval).
 * 6. No rAF anywhere: frames advance via chained setTimeout honoring each
 *    frame's durationMs. All timers are cleared on sleep and on
 *    document.hidden, so idle CPU is ~0.
 */

import { loadSprites } from './spriteLoader.js';

// --- MochiState (defensive: another agent writes src/state/mochiState.js) ---
const FALLBACK_MOCHI_STATE = {
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  NEEDS_APPROVAL: 'needs-approval',
  DONE: 'done',
  ERROR: 'error',
};
let MochiState = FALLBACK_MOCHI_STATE;
try {
  const mod = await import('../../state/mochiState.js');
  MochiState = mod.MochiState || mod.default || FALLBACK_MOCHI_STATE;
} catch {
  /* mochiState.js not present yet — use the fallback enum */
}

const TILE = 32; // source frame size in px
const MIN_SCALE = 2;
const MAX_SCALE = 6;
const FADE_MS = 150; // crossfade duration (ms) when switching animation sets
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

  // ---------- mutable state ----------
  let config = { ...DEFAULTS };
  let sprites = opts.sprites || null;
  let scale = DEFAULTS.scale;
  try {
    const s = opts.getScale ? opts.getScale() : null;
    if (Number.isFinite(s)) scale = clampInt(s, MIN_SCALE, MAX_SCALE) || DEFAULTS.scale;
  } catch { /* keep default */ }

  let mode = 'idle'; // idle | sleep | drag | peek
  let agentState = MochiState.IDLE;
  let agentToken = 0;
  let destroyed = false;
  let peekOn = false;

  let player = { name: null, index: 0, loop: true, onDone: null };
  let frameTimer = null;
  const timers = new Set();
  let idleActionT = null;
  let blinkT = null;
  let sleepT = null;
  let peekT = null;
  let dotsI = null;

  let uiOverlay = false; // window-level UI (onboarding bubble) is up
  let fadeSnap = null;   // outgoing-frame snapshot for the crossfade
  let fadeT0 = 0;
  let wanderT = null;    // long-cycle wander timer
  let wandering = false; // a wander glide is in progress

  let tiltX = 0; // draw offset in device px (hover tilt, walk wobble)
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
  const badgeEl = document.getElementById('panel-badge');
  const dotsEl = document.createElement('div');
  dotsEl.className = 'mochi-dots';
  // Static styling lives in .mochi-dots (styles.css) for CSP.
  const disposers = [];
  const on = (target, ev, fn, o) => {
    target.addEventListener(ev, fn, o);
    disposers.push(() => target.removeEventListener(ev, fn, o));
  };

  // ---------- tiny timer helper (all timers die on destroy) ----------
  function later(fn, ms) {
    if (destroyed) return null;
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
    return id;
  }

  // ---------- config ----------
  async function loadConfig() {
    try {
      const c = await bridge.getConfig();
      if (c && typeof c === 'object') config = { ...config, ...c };
    } catch { /* keep current config */ }
    try {
      const s = opts.getScale ? opts.getScale() : null;
      if (Number.isFinite(s)) {
        const n = clampInt(s, MIN_SCALE, MAX_SCALE);
        if (n) config.scale = n;
      }
    } catch { /* keep current */ }
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

  // ---------- animation player ----------
  function getAnim(name) {
    const anims = sprites && sprites.map.animations;
    const a = anims && anims[name];
    if (a && Array.isArray(a.frames) && a.frames.length) return a;
    const fb = anims && anims['idle-sit'];
    if (fb && Array.isArray(fb.frames) && fb.frames.length) return fb;
    return { frames: [{ x: 0, y: 0, w: TILE, h: TILE, durationMs: 120 }] };
  }

  function drawCurrentFrame() {
    if (!sprites) return;
    const anim = getAnim(player.name || 'idle-sit');
    const f = anim.frames[player.index] || anim.frames[0];
    const s = scale;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sprites.img, f.x, f.y, f.w, f.h, tiltX, 0, f.w * s, f.h * s);
    if (fadeSnap) {
      // Crossfade: the outgoing animation's last frame fades out over the
      // incoming one. Smoothing stays off throughout; this is a straight
      // alpha composite, so pixels stay crisp.
      const t = (performance.now() - fadeT0) / FADE_MS;
      if (t >= 1) {
        fadeSnap = null;
      } else {
        ctx.globalAlpha = 1 - t;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(fadeSnap, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
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
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
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
    // Snapshot the outgoing frame so the switch crossfades (~150ms) instead
    // of cutting. Skipped for the very first animation and for same-name
    // restarts (e.g. settling back to idle-sit).
    if (player.name && player.name !== name && sprites && !destroyed) {
      try {
        const snap = document.createElement('canvas');
        snap.width = canvas.width;
        snap.height = canvas.height;
        const sg = snap.getContext('2d');
        sg.imageSmoothingEnabled = false;
        sg.drawImage(canvas, 0, 0);
        fadeSnap = snap;
        fadeT0 = performance.now();
        // A few extra redraws so the fade progresses even between frames.
        for (let i = 1; i <= 4; i++) {
          later(() => { if (fadeSnap && !destroyed) drawCurrentFrame(); }, i * 38);
        }
      } catch {
        fadeSnap = null; // snapshot failed: cut instead of fading
      }
    } else {
      fadeSnap = null;
    }
    player = { name, index: 0, loop: !!loop, onDone: onDone || null };
    advanceFrame();
  }
  const playLoop = (name) => startAnim(name, true, null);
  const playOnce = (name, onDone) => startAnim(name, false, onDone);

  const lifeActive = () => !destroyed && mode === 'idle' && agentState === MochiState.IDLE;

  // ---------- life loop ----------
  function settleIdle() {
    if (destroyed || mode !== 'idle') return;
    tiltX = 0;
    looking = null;
    playLoop('idle-sit');
    scheduleIdleAction();
    scheduleBlink(); // no-op if already armed
  }

  function scheduleIdleAction() {
    if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
    if (destroyed) return;
    const lo = 3500, hi = 9000;
    idleActionT = later(doIdleAction, lo + Math.random() * (hi - lo));
  }

  function doIdleAction() {
    idleActionT = null;
    if (!lifeActive()) return;
    const calm = isCalm();
    const r = Math.random();
    if (r < 0.18) playOnce('ear-twitch', settleIdle);
    else if (r < 0.32) playOnce('tail-wag', settleIdle);
    else if (r < 0.46) lookAround();
    else if (r < 0.54 && !calm) playOnce('scratch', settleIdle);
    else if (r < 0.62 && !calm) playOnce('yawn', settleIdle);
    else if (r < 0.68 && !calm) playOnce('stretch', settleIdle);
    else if (r < 0.74 && !calm) playOnce('sneeze', settleIdle);
    else if (r < 0.80 && !calm) playOnce('shake', settleIdle);
    else if (r < 0.86 && !calm) playOnce('tail-chase', settleIdle);
    else if (r < 0.92 && !calm) doWalk();
    else if (!calm) playOnce('tail-wag', settleIdle);
    else settleIdle(); // calm: mostly just sit; blink timer covers blinking
  }

  function lookAround() {
    if (!lifeActive()) return;
    const anim = LOOK_ANIMS[(Math.random() * LOOK_ANIMS.length) | 0];
    playOnce(anim, settleIdle);
  }

  function doWalk() {
    if (!lifeActive()) return;
    const dir = Math.random() < 0.5 ? 'walk-left' : 'walk-right';
    playLoop(dir);
    // in-place wobble: the window doesn't move, so the dog paces on the spot
    [1, -1, 1, 0].forEach((o, i) => {
      later(() => { if (lifeActive()) tiltX = o * scale; }, i * 300);
    });
    later(() => { if (mode === 'idle') { tiltX = 0; settleIdle(); } }, 1300);
  }

  function clearBlink() {
    if (blinkT) { clearTimeout(blinkT); timers.delete(blinkT); blinkT = null; }
  }

  function scheduleBlink() {
    // Guard: never reset an already-armed blink timer, so one-shot actions
    // completing via settleIdle() don't starve the 3-6s blink cadence.
    if (blinkT || destroyed) return;
    const calm = isCalm();
    const ms = calm ? 6000 + Math.random() * 4000 : 3000 + Math.random() * 3000;
    blinkT = later(() => {
      blinkT = null;
      // Only blink when sitting at rest — never interrupt another action.
      if (lifeActive() && player.name === 'idle-sit') {
        playOnce('blink', () => { if (lifeActive() && mode === 'idle') playLoop('idle-sit'); });
      }
      scheduleBlink();
    }, ms);
  }

  // ---------- inactivity / sleep ----------
  function resetSleepTimer() {
    if (sleepT) { clearTimeout(sleepT); timers.delete(sleepT); sleepT = null; }
    if (destroyed || mode === 'sleep' || mode === 'peek') return;
    if (agentState !== MochiState.IDLE) return; // never sleep mid-task
    const mins = Math.max(0.05, Number(config.sleepAfterMinutes) || DEFAULTS.sleepAfterMinutes);
    sleepT = later(() => { sleepT = null; sleep(); }, mins * 60000);
  }

  function poke() {
    if (destroyed) return;
    if (mode === 'sleep') { wake(); return; }
    resetSleepTimer();
  }

  function sleep() {
    if (destroyed || mode === 'sleep' || mode === 'drag') return;
    clearAgentVisuals();
    mode = 'sleep';
    wandering = false;
    clearWanderTimer();
    if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
    clearBlink();
    if (sleepT) { clearTimeout(sleepT); timers.delete(sleepT); sleepT = null; }
    stopPlayer();
    // Static sleep frame + static zzz: zero timers while asleep.
    player = { name: 'sleep', index: 0, loop: false, onDone: null };
    drawCurrentFrame();
    if (effects) {
      const p = effectXY('zzz');
      effects.show('zzz', { x: Math.min(p.x + 10 * scale, canvas.width - 8 * scale), y: 0, static: true });
    }
  }

  function wake() {
    if (destroyed || mode !== 'sleep') return;
    if (effects) effects.clear('zzz');
    loadConfig(); // refresh settings (calm mode etc.) on wake
    mode = 'idle';
    playOnce('wake', settleIdle);
    scheduleWander();
    resetSleepTimer();
  }

  // ---------- agent reactions ----------
  function effectXY(name) {
    const fx = sprites && sprites.map.effects[name];
    const f = fx && fx.frames[0];
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
    const tick = () => { dotsEl.textContent = frames[i++ % frames.length]; };
    tick();
    dotsI = setInterval(tick, 450);
  }
  function hideDots() {
    if (dotsI) { clearInterval(dotsI); dotsI = null; }
    dotsEl.style.display = 'none';
  }

  function showBadge(on_) {
    try {
      if (badgeEl) badgeEl.style.display = on_ ? 'block' : 'none';
    } catch { /* badge element optional */ }
  }

  function clearAgentVisuals() {
    if (effects) for (const n of AGENT_EFFECTS) effects.clear(n);
    hideDots();
    showBadge(false);
  }

  function setAgentState(state) {
    const tok = ++agentToken;
    agentState = state || MochiState.IDLE;
    clearAgentVisuals();
    if (destroyed) return;
    if (mode === 'sleep') wake();
    if (mode === 'peek') setPeekMode(false);
    if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
    clearBlink();
    wandering = false;
    clearWanderTimer();
    stopPlayer();

    switch (agentState) {
      case MochiState.THINKING:
        playLoop('think');
        if (effects) effects.show('ellipsis', { x: effectXY('ellipsis').x, y: 2, loop: true });
        break;
      case MochiState.WORKING:
        playLoop('work');
        showDots();
        break;
      case MochiState.NEEDS_APPROVAL:
        playOnce('alert-bark', () => {
          if (agentToken === tok && agentState === MochiState.NEEDS_APPROVAL) playLoop('idle-sit');
        });
        if (effects) effects.show('exclaim', { x: effectXY('exclaim').x, y: 2, loop: true });
        showBadge(true);
        try { if (typeof bridge.focusWindow === 'function') bridge.focusWindow(); } catch { /* optional */ }
        break;
      case MochiState.DONE:
        if (isCalm()) {
          playLoop('idle-sit');
        } else {
          playOnce('hop', () => { if (agentToken === tok) playLoop('idle-sit'); });
        }
        if (effects) effects.show('sparkle', { x: effectXY('sparkle').x, y: 14, ms: 1600 });
        later(() => { if (agentToken === tok) setAgentState(MochiState.IDLE); }, 1600);
        break;
      case MochiState.ERROR:
        playLoop('sad');
        if (effects) effects.show('sweat', { x: effectXY('sweat').x, y: 4, loop: true });
        break;
      default:
        agentState = MochiState.IDLE;
        if (mode === 'idle') settleIdle();
    }
    resetSleepTimer();
  }

  // ---------- click-through hit testing ----------
  function alphaAt(sx, sy) {
    if (!alphaData || sx < 0 || sy < 0 || sx >= TILE || sy >= TILE) return 0;
    return alphaData[(sy * TILE + sx) * 4 + 3];
  }

  function updateClickThrough(clientX, clientY) {
    if (dragging || destroyed) return;
    if (typeof bridge.setIgnoreMouseEvents !== 'function') return;
    if (uiOverlay) {
      // A window-level UI bubble (e.g. the first-run onboarding bubble) is
      // up: keep the window mouse-active so the bubble stays clickable.
      try { bridge.setIgnoreMouseEvents(false); } catch { /* optional */ }
      return;
    }
    const r = canvas.getBoundingClientRect();
    const sx = Math.floor((clientX - r.left) / scale);
    const sy = Math.floor((clientY - r.top) / scale);
    const transparent = alphaAt(sx, sy) < 8;
    try {
      bridge.setIgnoreMouseEvents(transparent);
    } catch { /* optional */ }
  }

  // ---------- mouse: eye-follow, bark, petting ----------
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
      if (looking) { looking = null; playLoop('idle-sit'); }
      return;
    }
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const dir =
      ang >= -45 && ang < 45 ? 'look-right'
      : ang >= 45 && ang < 135 ? 'look-down'
      : ang >= -135 && ang < -45 ? 'look-up'
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
      // Cursor within ~120px of the dog wakes it (window is tiny, so in
      // practice any activity over the window wakes the dog).
      if (distToCenter(e.clientX, e.clientY) < 120) wake();
      return;
    }

    poke();
    updateClickThrough(e.clientX, e.clientY);

    // While a UI overlay (onboarding) is up, hover antics stay quiet so the
    // bubble has the user's full attention. Dragging still works (tour step).
    if (!uiOverlay) {
      // Fast cursor movement -> perk up (throttled, not in calm mode).
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

      // Petting: rapid rubbing over the head region (several hits within 600ms).
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
  }

  function onMouseEnter() {
    if (!lifeActive()) return;
    tiltX = scale; // slight tilt (draw offset) while the ear twitches
    playOnce('ear-twitch', () => {
      tiltX = 0;
      if (lifeActive()) settleIdle();
    });
  }

  function onMouseLeave() {
    tiltX = 0;
  }

  // ---------- drag & click ----------
  async function windowPosition() {
    try {
      const p = await bridge.getPosition();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch { /* fall through */ }
    return { x: 0, y: 0 };
  }

  async function onMouseDown(e) {
    if (destroyed || e.button !== 0) return;
    // mousedown only fires on opaque pixels (click-through), so the dog
    // itself was pressed.
    if (mode === 'sleep') { wake(); return; }
    poke();
    const pos = await windowPosition();
    pressInfo = {
      t: Date.now(),
      sx: e.screenX, sy: e.screenY,
      dx: e.screenX - pos.x, dy: e.screenY - pos.y, // cursor grab offset
    };
    try {
      if (e.pointerId != null && canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    } catch { /* optional */ }
  }

  function handleDragMove(e) {
    const p = pressInfo;
    if (!p || destroyed) return;
    if (!dragging && Math.hypot(e.screenX - p.sx, e.screenY - p.sy) > 5) {
      dragging = true;
      mode = 'drag';
      wandering = false;
      clearWanderTimer();
      if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
      clearBlink();
      if (sleepT) { clearTimeout(sleepT); timers.delete(sleepT); sleepT = null; }
      stopPlayer();
      playLoop('drag-dangle');
      try { bridge.setIgnoreMouseEvents(false); } catch { /* optional */ }
    }
    if (dragging) {
      const now = Date.now();
      if (now - lastDragSave > 16) {
        lastDragSave = now;
        // ASSUMPTION: main's savePosition handler also calls win.setPosition.
        try {
          bridge.savePosition(Math.round(e.screenX - p.dx), Math.round(e.screenY - p.dy));
        } catch { /* optional */ }
      }
    }
  }

  function onMouseUp(e) {
    if (!pressInfo) return;
    const p = pressInfo;
    pressInfo = null;
    if (destroyed) { dragging = false; return; }
    const dt = Date.now() - p.t;
    const moved = Math.hypot(e.screenX - p.sx, e.screenY - p.sy);
    if (dragging) {
      dragging = false;
      try {
        bridge.savePosition(Math.round(e.screenX - p.dx), Math.round(e.screenY - p.dy));
      } catch { /* optional */ }
      mode = 'idle';
      playOnce('drop-bounce', settleIdle);
      resetSleepTimer();
    } else if (dt < 300 && moved < 5) {
      // Clean click (not a drag): toggle the panel — unless a UI overlay
      // (onboarding) is up, in which case clicks stay with the bubble.
      if (uiOverlay) return;
      loadConfig(); // refresh settings on interaction
      try { onPanelToggleRequest(); } catch { /* optional */ }
    }
  }

  // ---------- peek mode ----------
  function applyPeekTransform() {
    const sliver = 10 * scale; // how much of the dog stays visible
    canvas.style.transform = `translateX(${canvas.width - sliver}px)`;
  }

  function schedulePeek() {
    if (peekT) { clearTimeout(peekT); timers.delete(peekT); peekT = null; }
    if (destroyed) return;
    peekT = later(() => {
      peekT = null;
      if (mode !== 'peek' || destroyed) return;
      playOnce('peek', () => {
        if (mode === 'peek') { playLoop('peek'); schedulePeek(); }
      });
    }, 8000 + Math.random() * 12000);
  }

  function setPeekMode(on_) {
    peekOn = !!on_;
    if (destroyed) return;
    if (peekOn) {
      if (mode === 'sleep') wake();
      mode = 'peek';
      wandering = false;
      clearWanderTimer();
      clearAgentVisuals();
      if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
      clearBlink();
      if (sleepT) { clearTimeout(sleepT); timers.delete(sleepT); sleepT = null; }
      stopPlayer();
      applyPeekTransform();
      playLoop('peek');
      schedulePeek();
    } else {
      canvas.style.transform = '';
      if (peekT) { clearTimeout(peekT); timers.delete(peekT); peekT = null; }
      mode = 'idle';
      settleIdle();
      scheduleWander();
      resetSleepTimer();
    }
  }

  // ---------- UI overlay (onboarding bubble) ----------
  // While a window-level UI element is up, the dog quiets its hover antics
  // and the window is kept mouse-active so the overlay stays clickable.
  // Dragging the dog keeps working (it's part of the onboarding tour).
  function setUiOverlay(on_) {
    uiOverlay = !!on_;
    if (destroyed) return;
    if (uiOverlay) {
      try { bridge.setIgnoreMouseEvents(false); } catch { /* optional */ }
    }
  }

  // ---------- wander (optional) ----------
  // When config.wanderEnabled === true, the dog occasionally glides to a
  // nearby on-screen spot on its own, playing a walk animation. Purely
  // renderer-side: current position via bridge.getPosition(), movement via
  // bridge.savePosition() (main moves the window live and persists
  // debounced). Aborts instantly on user grab, agent activity, sleep, peek,
  // or overlay — it never fights the user or position memory.
  function clearWanderTimer() {
    if (wanderT) { clearTimeout(wanderT); timers.delete(wanderT); wanderT = null; }
  }

  function scheduleWander() {
    if (wanderT || destroyed) return;
    // Long, lazy cycle. The fire-time guard re-reads config, so flipping
    // wanderEnabled takes effect without a restart.
    wanderT = later(() => {
      wanderT = null;
      if (destroyed || document.hidden) { scheduleWander(); return; }
      if (
        config.wanderEnabled === true &&
        !isCalm() &&
        lifeActive() &&
        !uiOverlay &&
        !wandering &&
        Math.random() < 0.55
      ) {
        doWander();
      }
      scheduleWander();
    }, 150000 + Math.random() * 270000); // every 2.5–7 minutes
  }

  async function doWander() {
    if (wandering || destroyed || !lifeActive() || uiOverlay) return;
    let pos = null;
    try {
      pos = await bridge.getPosition();
    } catch { /* skip this cycle */ }
    if (wandering || destroyed || !lifeActive() || uiOverlay || dragging || pressInfo) return;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const size = TILE * scale;
    // Clamp the target to the current screen's available area so the dog
    // never walks off-screen. (No screen API on the bridge; window.screen
    // is enough for this.)
    let minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
    try {
      const s = window.screen;
      if (s && Number.isFinite(s.availWidth) && Number.isFinite(s.availHeight)) {
        minX = Number(s.availLeft) || 0;
        minY = Number(s.availTop) || 0;
        maxX = minX + Math.max(0, s.availWidth - size);
        maxY = minY + Math.max(0, s.availHeight - size);
      }
    } catch { /* keep unbounded */ }
    const dx = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 56);
    const dy = (Math.random() - 0.5) * 72;
    const tx = Math.round(Math.min(maxX, Math.max(minX, pos.x + dx)));
    const ty = Math.round(Math.min(maxY, Math.max(minY, pos.y + dy)));
    if (Math.hypot(tx - pos.x, ty - pos.y) < 24) return; // boxed in; skip
    wandering = true;
    if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
    clearBlink();
    stopPlayer();
    playLoop(dx < 0 ? 'walk-left' : 'walk-right');
    const x0 = pos.x, y0 = pos.y;
    const steps = 22, stepMs = 64; // ~1.4s eased glide
    for (let i = 1; i <= steps; i++) {
      later(() => {
        if (!wandering) return;
        if (destroyed || dragging || pressInfo || mode !== 'idle' ||
            agentState !== MochiState.IDLE || uiOverlay) {
          wandering = false;
          if (!destroyed && !dragging && !uiOverlay && mode === 'idle' &&
              agentState === MochiState.IDLE) {
            settleIdle();
          }
          return;
        }
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
        try {
          bridge.savePosition(Math.round(x0 + (tx - x0) * e), Math.round(y0 + (ty - y0) * e));
        } catch { /* optional */ }
        if (i === steps) {
          wandering = false;
          tiltX = 0;
          settleIdle();
        }
      }, i * stepMs);
    }
  }

  // ---------- scale ----------
  function sizeCanvas() {
    canvas.width = TILE * scale;
    canvas.height = TILE * scale;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    canvas.style.imageRendering = 'pixelated';
  }

  function setScale(n) {
    const nn = clampInt(n, MIN_SCALE, MAX_SCALE);
    if (!nn || nn === scale) return;
    scale = nn;
    fadeSnap = null; // drop any in-flight crossfade (snapshot is the old size)
    sizeCanvas();
    drawCurrentFrame();
    if (effects && typeof effects.setScale === 'function') effects.setScale(nn);
    if (mode === 'peek') applyPeekTransform();
    if (lastMouse) updateClickThrough(lastMouse.x, lastMouse.y);
  }

  // ---------- document visibility: fully pause timers when hidden ----------
  function onVisibilityChange() {
    if (destroyed) return;
    if (document.hidden) {
      stopPlayer();
      if (idleActionT) { clearTimeout(idleActionT); timers.delete(idleActionT); idleActionT = null; }
      clearBlink();
      if (peekT) { clearTimeout(peekT); timers.delete(peekT); peekT = null; }
      // sleepT intentionally keeps running: an idle-away user should find
      // the dog asleep.
    } else {
      if (mode === 'sleep') { drawCurrentFrame(); return; }
      advanceFrame(); // resume mid-animation from the saved frame index
      if (mode === 'idle' && agentState === MochiState.IDLE) {
        scheduleIdleAction();
        scheduleBlink();
      }
      if (mode === 'peek') schedulePeek();
    }
  }

  // ---------- destroy ----------
  function destroy() {
    destroyed = true;
    wandering = false;
    clearWanderTimer();
    for (const d of disposers.splice(0)) {
      try { d(); } catch { /* ignore */ }
    }
    for (const id of [...timers]) { clearTimeout(id); timers.delete(id); }
    stopPlayer();
    if (dotsI) { clearInterval(dotsI); dotsI = null; }
    if (effects) effects.clearAll();
    showBadge(false);
    try { dotsEl.remove(); } catch { /* ignore */ }
    try { bridge.setIgnoreMouseEvents(false); } catch { /* optional */ }
  }

  // ---------- init ----------
  function wireEvents() {
    // Note: only window gets 'mousemove' — canvas events bubble to window, and
    // a second canvas-level listener would double-count petting/velocity.
    on(window, 'mousemove', onMouseMove);
    on(window, 'mouseup', onMouseUp);
    on(canvas, 'mouseenter', onMouseEnter);
    on(canvas, 'mouseleave', onMouseLeave);
    on(canvas, 'mousedown', onMouseDown);
    on(document, 'visibilitychange', onVisibilityChange);
    try {
      if (typeof bridge.onSleepToggle === 'function') {
        bridge.onSleepToggle((v) => {
          // Main sends { sleeping: bool } via the tray; accept a bare boolean
          // too, and fall back to toggling when nothing usable arrives.
          const toSleep =
            typeof v === 'boolean' ? v
            : v && typeof v.sleeping === 'boolean' ? v.sleeping
            : mode !== 'sleep';
          if (toSleep) sleep(); else wake();
        });
      }
    } catch { /* optional */ }
  }

  async function init() {
    sizeCanvas();
    wireEvents();
    await loadConfig();
    // Apply config scale (no-op if unchanged).
    const cs = clampInt(config.scale, MIN_SCALE, MAX_SCALE);
    if (cs && cs !== scale) { scale = cs; sizeCanvas(); }
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
    scheduleWander();
    resetSleepTimer();
  }
  init();

  return { setAgentState, setScale, setPeekMode, setUiOverlay, sleep, wake, destroy };
}
