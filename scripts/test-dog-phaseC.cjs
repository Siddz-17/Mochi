#!/usr/bin/env node
'use strict';
/*
 * test-dog-phaseC.cjs — headless logic test for the Phase C dog.js changes.
 *
 * Manual timer scheduler + DOM stubs drive createDog() and verify:
 *  1. crossfade: switching animation sets composites the outgoing frame with
 *     globalAlpha < 1 (pixels stay crisp: imageSmoothingEnabled=false).
 *  2. uiOverlay: setUiOverlay(true) keeps the window mouse-active
 *     (setIgnoreMouseEvents(false)) even over transparent pixels; off again
 *     restores normal hit-testing.
 *  3. new idle actions: forcing the idle-action branch plays sneeze/shake/
 *     tail-chase frames from the real framemap.
 *  4. wander (config.wanderEnabled=true): the long-cycle timer fires a glide
 *     — 22 eased savePosition steps toward a screen-clamped target while a
 *     walk animation plays; an agent state change mid-glide aborts it.
 *  5. wander disabled by default: no savePosition calls, no crash.
 *
 * Run: node scripts/test-dog-phaseC.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function fail(msg) { failures += 1; console.error(`FAIL: ${msg}`); }
function ok(msg) { console.log(`ok: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

/* ---------- manual clock + timers ---------- */
let now = 0;
const timerList = [];
function installClock() {
  now = 0;
  timerList.length = 0;
  global.setTimeout = (fn, ms) => {
    const t = { fn, at: now + Math.max(0, ms || 0), fired: false, cleared: false, id: timerList.length };
    timerList.push(t);
    return t.id;
  };
  global.clearTimeout = (id) => { if (timerList[id]) timerList[id].cleared = true; };
  global.performance = { now: () => now };
}
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const t of timerList) {
      if (!t.fired && !t.cleared && t.at <= end && (!next || t.at < next.at)) next = t;
    }
    if (!next) break;
    now = next.at;
    next.fired = true;
    next.fn();
  }
  now = end;
}
const flush = () => new Promise((r) => setImmediate(r));

/* ---------- scripted Math.random ---------- */
let randomScript = [];
const realRandom = Math.random;
function installRandom() {
  randomScript = [];
  Math.random = () => (randomScript.length ? randomScript.shift() : 0.5);
}
function restoreRandom() { Math.random = realRandom; }

/* ---------- DOM stubs ---------- */
const winListeners = {};
function makeCtx(rec) {
  return {
    rec,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    clearRect() {},
    drawImage(img, ...rest) { this.rec.push({ alpha: this.globalAlpha, smooth: this.imageSmoothingEnabled, token: img && img.__tk, rest }); },
    getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; },
  };
}
function makeCanvas() {
  const rec = [];
  const ctx = makeCtx(rec);
  return {
    rec, ctx,
    width: 0, height: 0, style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {},
  };
}
function installDom() {
  for (const k of Object.keys(winListeners)) delete winListeners[k];
  const canvas = makeCanvas();
  global.document = {
    hidden: false,
    createElement: (tag) => {
      if (tag === 'canvas') return makeCanvas();
      return { className: '', style: {}, textContent: '', parentElement: null, remove() {} };
    },
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  };
  global.window = {
    innerWidth: 560,
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => {
      const a = winListeners[ev] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
  };
  return canvas;
}
function fireWin(ev, payload) {
  for (const fn of [...(winListeners[ev] || [])]) fn(payload);
}

/* ---------- bridge stub ---------- */
function makeBridge(cfg) {
  return {
    cfg,
    saved: [],       // savePosition calls
    ignoreCalls: [], // setIgnoreMouseEvents calls
    getConfig: async () => ({ ...cfg }),
    setConfig: async () => {},
    getPosition: async () => ({ x: 500, y: 500 }),
    savePosition: function (x, y) { this.saved.push([x, y]); },
    setIgnoreMouseEvents: function (v) { this.ignoreCalls.push(!!v); },
  };
}

/* sprites: real framemap geometry, token image */
function makeSprites() {
  const fm = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/sprites/framemap.json'), 'utf8'));
  return { img: { __tk: 'sheet' }, map: fm };
}

/* frame drawn from the spritesheet (excludes the fade-snapshot composite) */
function drewFrame(rec, frame) {
  return rec.some((c) => c.token === 'sheet' && c.rest[0] === frame.x && c.rest[1] === frame.y);
}

/* find the pending long-cycle wander timer (delay 150s-420s; the 60min
 * sleep timer also matches a bare >=140s filter) and mark it manually fired */
function takeWanderTimer() {
  const t = timerList.find((x) => {
    const d = x.at - now;
    return !x.fired && !x.cleared && d >= 140000 && d <= 500000;
  });
  assert(!!t, 'a long-cycle wander timer is scheduled');
  if (t) t.fired = true;
  return t;
}

async function main() {
  installClock();
  installRandom();
  const canvas = installDom();
  const { createDog } = await import(pathToFileURL(path.join(ROOT, 'src/renderer/dog.js')).href);
  const sprites = makeSprites();
  const fm = sprites.map;

  // ---------- boot with wander enabled ----------
  const bridge = makeBridge({ scale: 4, sleepAfterMinutes: 60, wanderEnabled: true });
  const dog = createDog(canvas, {
    bridge, effects: null, sprites,
    getScale: () => 4,
    onPanelToggleRequest: () => {},
  });
  await flush(); await flush();
  assert(drewFrame(canvas.rec, fm.animations['idle-sit'].frames[0]), 'dog boots and draws idle-sit headless');

  // ---------- 1. crossfade ----------
  canvas.rec.length = 0;
  dog.setAgentState('thinking'); // idle-sit -> think: different animation set
  advance(200); // fade ticker (4 x 38ms) runs inside the 150ms fade
  const faded = canvas.rec.filter((c) => c.alpha < 1 && c.alpha > 0);
  assert(faded.length > 0, `crossfade composites outgoing frame with 0<alpha<1 (${faded.length} draws)`);
  assert(
    canvas.rec.every((c) => c.smooth === false),
    'imageSmoothingEnabled stays false during crossfade draws'
  );
  canvas.rec.length = 0;
  advance(500);
  assert(
    canvas.rec.every((c) => c.alpha === 1),
    'no partial-alpha draws after the 150ms fade completes'
  );
  dog.setAgentState('idle');
  await flush();

  // ---------- 2. uiOverlay ----------
  bridge.ignoreCalls.length = 0;
  dog.setUiOverlay(true);
  assert(bridge.ignoreCalls[bridge.ignoreCalls.length - 1] === false, 'setUiOverlay(true) forces mouse-active');
  fireWin('mousemove', { clientX: 10, clientY: 200 }); // transparent area (alpha all 0)
  await flush();
  assert(
    bridge.ignoreCalls.length > 0 && bridge.ignoreCalls[bridge.ignoreCalls.length - 1] === false,
    'transparent hover keeps window mouse-active while overlay is up'
  );
  dog.setUiOverlay(false);
  fireWin('mousemove', { clientX: 10, clientY: 200 });
  await flush();
  assert(
    bridge.ignoreCalls[bridge.ignoreCalls.length - 1] === true,
    'overlay off restores normal transparent hit-testing'
  );

  // ---------- 3. new idle actions play real frames ----------
  // Long constant script: every random (branch + reschedule delays + blink)
  // returns branchR, so the forced branch is deterministic.
  async function forceIdleAction(branchR) {
    randomScript = new Array(60).fill(branchR);
    canvas.rec.length = 0;
    advance(12000);
    await flush();
    restoreRandom(); installRandom();
  }
  await forceIdleAction(0.70); // sneeze branch (0.68-0.74)
  assert(drewFrame(canvas.rec, fm.animations.sneeze.frames[0]), 'idle action plays the sneeze animation frames');
  await forceIdleAction(0.76); // shake branch (0.74-0.80)
  assert(drewFrame(canvas.rec, fm.animations.shake.frames[0]), 'idle action plays the shake animation frames');
  await forceIdleAction(0.82); // tail-chase branch (0.80-0.86)
  assert(drewFrame(canvas.rec, fm.animations['tail-chase'].frames[0]), 'idle action plays the tail-chase animation frames');

  // ---------- 4. wander glide ----------
  // Agent-state changes cancel the wander timer; re-arm via peek toggle.
  dog.setPeekMode(true);
  dog.setPeekMode(false);
  await flush();
  const wt = takeWanderTimer();
  // script randoms, in consumption order: fire-branch 0.1 (<0.55),
  // reschedule delay 0.5 (consumed synchronously after doWander suspends on
  // its getPosition await), dx sign 0.1 (<0.5 => left), dx magnitude 0.5 =>
  // 68px, dy 0.5 => 0
  randomScript = [0.1, 0.5, 0.1, 0.5, 0.5];
  const before = now;
  wt.fn(); // fire the long-cycle timer manually
  await flush(); await flush(); await flush(); // let doWander's awaits resolve
  restoreRandom(); installRandom();
  // glide steps land exactly on 64ms multiples; fade ticks (38ms) and the
  // walk frame timer (120ms) do not.
  const glides = timerList.filter(
    (t) => !t.fired && !t.cleared && t.at > before && t.at - before <= 1408 && (t.at - before) % 64 === 0
  );
  assert(glides.length === 22, `wander schedules a 22-step glide (got ${glides.length})`);
  canvas.rec.length = 0;
  advance(1600); // run the whole glide
  const saved = bridge.saved;
  assert(saved.length === 22, `glide emits 22 savePosition calls (got ${saved.length})`);
  const [lx, ly] = saved[saved.length - 1];
  assert(lx === 432 && ly === 500, `glide ends at the clamped target (432,500), got (${lx},${ly})`);
  const xs = saved.map((s) => s[0]);
  assert(xs.every((x, i) => i === 0 || x <= xs[i - 1]), 'glide x positions ease monotonically toward the target');
  assert(saved.every((s) => s[1] === 500), 'glide y stays constant for a horizontal wander');
  assert(
    drewFrame(canvas.rec, fm.animations['walk-left'].frames[0]),
    'walk-left animation plays during a leftward wander'
  );
  assert(
    drewFrame(canvas.rec, fm.animations['idle-sit'].frames[0]),
    'dog returns to idle-sit after the wander glide'
  );

  // ---------- wander abort: agent state change mid-glide ----------
  bridge.saved.length = 0;
  const wt2 = takeWanderTimer(); // the reschedule from the completed glide
  randomScript = [0.1, 0.5, 0.9, 0.5, 0.5]; // force branch, dx right this time
  wt2.fn();
  await flush(); await flush(); await flush();
  restoreRandom(); installRandom();
  advance(400); // a few steps in
  const midCount = bridge.saved.length;
  assert(midCount > 0 && midCount < 22, `glide in progress (${midCount} steps so far)`);
  dog.setAgentState('working'); // agent takes over mid-glide
  advance(1500);
  assert(bridge.saved.length === midCount, 'no further savePosition calls after the agent-state abort');
  assert(
    drewFrame(canvas.rec, fm.animations.work.frames[0]),
    'agent work animation takes over after the abort'
  );
  dog.setAgentState('idle');
  await flush();
  dog.destroy(); // clear the first dog's timers before the second instance

  // ---------- 5. wander disabled by default ----------
  const canvas2 = makeCanvas();
  const bridge2 = makeBridge({ scale: 4, sleepAfterMinutes: 60 }); // no wanderEnabled
  const dog2 = createDog(canvas2, {
    bridge: bridge2, effects: null, sprites,
    getScale: () => 4, onPanelToggleRequest: () => {},
  });
  await flush(); await flush();
  dog2.setPeekMode(true);
  dog2.setPeekMode(false);
  await flush();
  const wt3 = takeWanderTimer();
  randomScript = [0.1]; // would force the branch if the flag were on
  wt3.fn();
  await flush(); await flush();
  restoreRandom();
  assert(bridge2.saved.length === 0, 'no window movement when wanderEnabled is unset');
  dog2.destroy();

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll Phase C dog.js checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
