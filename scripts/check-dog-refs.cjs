/**
 * check-dog-refs.cjs — verification for the renderer "dog life" files.
 *
 * 1. Asserts every animation/effect name referenced in src/renderer/dog.js and
 *    src/renderer/effects.js exists in the canonical contract lists (the real
 *    framemap.json is built by another agent; this guards against typos).
 * 2. Asserts spriteLoader.js points at the contracted asset paths.
 * 3. Smoke-tests effects.js in Node with minimal DOM stubs (show/clear/
 *    auto-remove/loop/static/setScale).
 *
 * Run: node scripts/check-dog-refs.cjs   (from ~/workspace/Mochi)
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');

const KNOWN_ANIMATIONS = new Set([
  'idle-sit', 'blink', 'tail-wag', 'ear-twitch',
  'look-left', 'look-right', 'look-up', 'look-down',
  'walk-left', 'walk-right',
  'sleep', 'wake', 'yawn', 'stretch', 'scratch',
  'happy', 'pet-squint', 'hop', 'sad', 'think', 'work',
  'alert-bark', 'drag-dangle', 'drop-bounce', 'peek',
  'sneeze', 'shake', 'tail-chase',
]);
const KNOWN_EFFECTS = new Set([
  'heart', 'sparkle', 'ellipsis', 'exclaim', 'zzz', 'steam', 'sweat',
]);
// Dynamic template names like `walk-${dir}` / `look-...` — verify by prefix.
const KNOWN_DYNAMIC_PREFIXES = ['walk-', 'look-'];

let failures = 0;
function fail(msg) { failures += 1; console.error(`FAIL: ${msg}`); }
function ok(msg) { console.log(`ok: ${msg}`); }

function checkRefs() {
  const files = ['src/renderer/dog.js', 'src/renderer/effects.js'];
  const src = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

  // Literal names passed to play*/show()/effectXY().
  const litRe = /(?:playLoop|playOnce|startAnim|player\s*=\s*\{[^}]*name:\s*|show|effectXY|getAnim)\(\s*['"]([a-z][a-z-]*)['"]/g;
  const seen = new Set();
  let m;
  while ((m = litRe.exec(src))) seen.add(m[1]);

  // player = { name: 'sleep', ... } style assignments not caught above.
  const nameAssignRe = /name:\s*['"]([a-z][a-z-]*)['"]/g;
  while ((m = nameAssignRe.exec(src))) seen.add(m[1]);

  for (const name of [...seen].sort()) {
    if (KNOWN_ANIMATIONS.has(name) || KNOWN_EFFECTS.has(name)) {
      ok(`referenced "${name}" is in the contract`);
    } else {
      fail(`referenced "${name}" is NOT in the animation/effect contract lists`);
    }
  }

  // Dynamic template names: `walk-${dir}` etc.
  const dynRe = /`([a-z]+-)\$\{/g;
  const dynSeen = new Set();
  while ((m = dynRe.exec(src))) dynSeen.add(m[1]);
  for (const prefix of dynSeen) {
    if (KNOWN_DYNAMIC_PREFIXES.includes(prefix)) ok(`dynamic prefix "${prefix}" is known`);
    else fail(`dynamic prefix "${prefix}" is unknown`);
  }
}

function checkLoaderPaths() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/spriteLoader.js'), 'utf8');
  for (const p of ['assets/sprites/spritesheet.png', 'assets/sprites/framemap.json']) {
    const short = p.split('/').slice(-1)[0];
    if (src.includes(short) && src.includes('assets/sprites')) ok(`spriteLoader references ${p}`);
    else fail(`spriteLoader missing reference to ${p}`);
  }
}

// ---------- effects.js smoke test with DOM stubs ----------
function makeCtx() {
  return { imageSmoothingEnabled: true, clearRect() {}, drawImage() {} };
}
function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    setAttribute() {},
    removed: false,
    remove() { this.removed = true; },
    getContext: () => makeCtx(),
  };
}
function installStubs() {
  global.document = {
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {} }),
  };
  global.window = {};
}
function makeLayer() {
  return {
    clientWidth: 128, clientHeight: 128, children: [],
    appendChild(c) { this.children.push(c); },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function smokeEffects() {
  installStubs();
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/renderer/effects.js')).href);
  const sprites = {
    img: {},
    map: {
      effects: {
        heart: { loop: false, frames: [
          { x: 0, y: 0, w: 8, h: 8, durationMs: 30 },
          { x: 8, y: 0, w: 8, h: 8, durationMs: 30 },
        ] },
        zzz: { loop: true, frames: [{ x: 0, y: 0, w: 8, h: 8, durationMs: 40 }] },
      },
    },
  };
  const layer = makeLayer();
  const fx = mod.createEffects(layer, sprites);

  // one-shot with ms auto-removes
  const e1 = fx.show('heart', { x: 10, y: 4, ms: 120 });
  if (!e1) return fail('show(heart) returned null');
  if (layer.children.length !== 1) return fail('heart canvas not appended');
  if (e1.canvas.style.left !== '10px') return fail(`heart x wrong: ${e1.canvas.style.left}`);
  if (e1.canvas.width !== 8 * 4) return fail(`heart not drawn at integer scale 4: ${e1.canvas.width}`);
  ok('show() appends a pixelated integer-scale canvas at the given position');
  await sleep(250);
  if (!e1.canvas.removed) return fail('heart was not auto-removed after ms');
  ok('show(..., {ms}) auto-removes');

  // looping effect persists until clear()
  fx.show('zzz', { loop: true });
  await sleep(120);
  const zzzCanvas = layer.children[layer.children.length - 1];
  if (zzzCanvas.removed) return fail('looping zzz removed itself');
  fx.clear('zzz');
  if (!zzzCanvas.removed) return fail('clear(zzz) did not remove the canvas');
  ok('looping effects persist until clear()');

  // static: no frame timers at all
  const st = fx.show('zzz', { static: true });
  if (st.frameTimer) return fail('static effect scheduled frame timers');
  fx.clearAll();
  if (!st.canvas.removed) return fail('clearAll() missed the static effect');
  ok('static:true draws once with no timers; clearAll() works');

  // unknown name warns and returns null (does not throw)
  if (fx.show('nope') !== null) return fail('show(unknown) should return null');
  ok('unknown effect names return null');

  // setScale re-lays-out live effects
  const sc = fx.show('zzz', { loop: true });
  fx.setScale(2);
  if (sc.canvas.width !== 8 * 2) return fail(`setScale did not resize live effect: ${sc.canvas.width}`);
  fx.clearAll();
  ok('setScale() re-lays-out live effects');

  // default centering when x/y omitted (scale back to 4: 8px frame -> 32px)
  fx.setScale(4);
  const c = fx.show('heart', { ms: 50 });
  if (c.canvas.style.left !== `${(128 - 32) / 2}px`) {
    return fail(`default centering wrong: ${c.canvas.style.left}`);
  }
  fx.clearAll();
  ok('effects default to horizontal centering');
}

async function main() {
  console.log('--- name reference checks ---');
  checkRefs();
  console.log('--- spriteLoader path checks ---');
  checkLoaderPaths();
  console.log('--- effects.js smoke test ---');
  await smokeEffects();
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => { console.error(err); process.exit(1); });
