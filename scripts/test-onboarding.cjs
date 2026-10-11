#!/usr/bin/env node
'use strict';
/*
 * test-onboarding.cjs — headless test for src/renderer/onboarding.js.
 *
 * Stubs just enough DOM/localStorage to drive the first-run bubble:
 *  1. flag already set        -> returns null, builds nothing
 *  2. flag unset              -> builds bubble, sets flag, uiOverlay(true)
 *  3. name step Next          -> bridge.setConfig({userName}) called, advances
 *  4. Skip                    -> bubble removed, uiOverlay(false)
 *  5. second call             -> null (exactly-once)
 *  6. localStorage broken     -> fail closed (null, no bubble)
 *
 * Run: node scripts/test-onboarding.cjs
 */
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
function fail(msg) { failures += 1; console.error(`FAIL: ${msg}`); }
function ok(msg) { console.log(`ok: ${msg}`); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

/* ---------- minimal DOM stubs ---------- */
function makeEl(tag) {
  const e = {
    tag, children: [], listeners: {}, removed: false,
    className: '', textContent: '', value: '', type: '',
    placeholder: '', maxLength: 0, style: {},
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.removed = true; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    focus() {},
    __click() { for (const fn of this.listeners.click || []) fn({}); },
    __keydown(key) { for (const fn of this.listeners.keydown || []) fn({ key }); },
  };
  return e;
}

function installStubs({ flagSet = false, storageBroken = false } = {}) {
  const store = flagSet ? { 'mochi.onboarded': '1' } : {};
  const body = makeEl('body');
  const canvasStub = {
    getBoundingClientRect: () => ({ right: 140, top: 4, bottom: 140, left: 12 }),
  };
  global.document = {
    createElement: (t) => makeEl(t),
    getElementById: (id) => (id === 'dog-canvas' ? canvasStub : null),
    body,
  };
  global.window = { innerWidth: 560 };
  global.localStorage = storageBroken
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
    : {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      };
  return { store, body };
}

function findByClass(root, cls) {
  if (root.className === cls) return root;
  for (const c of root.children) {
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/onboarding.js')).href);
  const { maybeShowOnboarding } = mod;

  // 1. flag already set -> null, nothing built
  {
    const { body } = installStubs({ flagSet: true });
    const calls = [];
    const r = maybeShowOnboarding({
      bridge: {}, getConfig: () => ({}),
      dog: { setUiOverlay: (v) => calls.push(v) },
    });
    assert(r === null, 'returns null when mochi.onboarded is already set');
    assert(body.children.length === 0, 'builds no DOM when already onboarded');
    assert(calls.length === 0, 'does not touch uiOverlay when already onboarded');
  }

  // 2. first run -> bubble, flag set, uiOverlay(true)
  let uiCalls, setConfigCalls, bodyRef, handle, storeRef;
  {
    const st = installStubs();
    storeRef = st.store; bodyRef = st.body;
    uiCalls = []; setConfigCalls = [];
    handle = maybeShowOnboarding({
      bridge: { setConfig: (p) => setConfigCalls.push(p) },
      getConfig: () => ({ userName: '' }),
      dog: { setUiOverlay: (v) => uiCalls.push(v) },
    });
    assert(handle && handle.el, 'returns a handle on first run');
    assert(storeRef['mochi.onboarded'] === '1', 'sets mochi.onboarded flag on show');
    assert(bodyRef.children.length === 1, 'appends the bubble to body');
    assert(uiCalls.join(',') === 'true', 'calls dog.setUiOverlay(true) while visible');
    const root = bodyRef.children[0];
    assert(findByClass(root, 'mob-title').textContent.length > 0, 'bubble has a title');
    assert(findByClass(root, 'mob-name') !== null, 'step 0 shows the name input');
    assert(findByClass(root, 'mob-skip').textContent === 'Skip', 'bubble has a Skip button');
  }

  // 3. type a name, press Next -> saved via setConfig, advances a step
  {
    const root = bodyRef.children[0];
    findByClass(root, 'mob-name').value = '  SID  ';
    const titleBefore = findByClass(root, 'mob-title').textContent;
    findByClass(root, 'mob-next').__click();
    assert(
      setConfigCalls.length === 1 && setConfigCalls[0].userName === 'SID',
      'saves trimmed name via bridge.setConfig({ userName })'
    );
    assert(
      findByClass(root, 'mob-title').textContent !== titleBefore,
      'Next advances to the tour step'
    );
    assert(findByClass(root, 'mob-name').style.display === 'none', 'name input hidden after step 0');
  }

  // 4. walk through remaining steps -> Done dismisses, uiOverlay(false)
  {
    const root = bodyRef.children[0];
    findByClass(root, 'mob-next').__click(); // step 2
    findByClass(root, 'mob-next').__click(); // step 3
    assert(findByClass(root, 'mob-next').textContent === 'Done!', 'last step CTA is Done!');
    findByClass(root, 'mob-next').__click(); // dismiss
    assert(root.removed, 'Done removes the bubble');
    assert(uiCalls.join(',') === 'true,false', 'calls dog.setUiOverlay(false) on dismiss');
  }

  // 5. exactly once: second call -> null
  {
    global.localStorage = {
      getItem: (k) => storeRef[k] || null,
      setItem: (k, v) => { storeRef[k] = String(v); },
    };
    const r = maybeShowOnboarding({ bridge: {}, getConfig: () => ({}), dog: {} });
    assert(r === null, 'second call returns null (shown exactly once)');
  }

  // 6. broken localStorage -> fail closed
  {
    const { body } = installStubs({ storageBroken: true });
    const r = maybeShowOnboarding({ bridge: {}, getConfig: () => ({}), dog: {} });
    assert(r === null, 'returns null when localStorage is unavailable');
    assert(body.children.length === 0, 'builds nothing when localStorage is unavailable');
  }

  // 7. Skip mid-flow dismisses without advancing
  {
    const st = installStubs();
    const ui = [];
    const h = maybeShowOnboarding({ bridge: {}, getConfig: () => ({}), dog: { setUiOverlay: (v) => ui.push(v) } });
    const root = st.body.children[0];
    findByClass(root, 'mob-skip').__click();
    assert(root.removed, 'Skip removes the bubble');
    assert(ui.join(',') === 'true,false', 'Skip restores uiOverlay(false)');
    assert(h !== null, 'handle was returned before Skip');
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll onboarding checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
