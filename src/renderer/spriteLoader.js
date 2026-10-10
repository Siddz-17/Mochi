/**
 * spriteLoader.js — loads Mochi's sprite sheet and frame map.
 *
 * Public API:
 *   loadSprites() -> Promise<{ img: HTMLImageElement, map: object }>
 *
 * Loads, relative to this module:
 *   ../../assets/sprites/spritesheet.png
 *   ../../assets/sprites/framemap.json
 *
 * The frame map schema (built by another agent) is:
 *   {
 *     "meta": { "tile": 32 },
 *     "animations": { "<name>": { "loop": bool,
 *                                 "frames": [{x,y,w,h,durationMs}, ...] } },
 *     "effects":     { "<name>": { "loop": bool,
 *                                 "frames": [{x,y,w,h,durationMs}, ...] } }
 *   }
 *
 * Known animation names (warns — does not throw — if any are missing):
 *   idle-sit, blink, tail-wag, ear-twitch, look-left, look-right, look-up,
 *   look-down, walk-left, walk-right, sleep, wake, yawn, stretch, scratch,
 *   happy, pet-squint, hop, sad, think, work, alert-bark, drag-dangle,
 *   drop-bounce, peek
 * Known effect names: heart, sparkle, ellipsis, exclaim, zzz, steam, sweat
 *
 * No network access: both assets are local files resolved via import.meta.url,
 * so this works under file:// in Electron and in a plain browser.
 */

const KNOWN_ANIMATIONS = [
  'idle-sit', 'blink', 'tail-wag', 'ear-twitch',
  'look-left', 'look-right', 'look-up', 'look-down',
  'walk-left', 'walk-right',
  'sleep', 'wake', 'yawn', 'stretch', 'scratch',
  'happy', 'pet-squint', 'hop', 'sad', 'think', 'work',
  'alert-bark', 'drag-dangle', 'drop-bounce', 'peek',
];

const KNOWN_EFFECTS = [
  'heart', 'sparkle', 'ellipsis', 'exclaim', 'zzz', 'steam', 'sweat',
];

/**
 * Load the sprite sheet image and the frame map.
 * @returns {Promise<{img: HTMLImageElement, map: object}>}
 */
export async function loadSprites() {
  const dir = new URL('../../assets/sprites/', import.meta.url);
  const pngURL = new URL('spritesheet.png', dir);
  const jsonURL = new URL('framemap.json', dir);

  const img = await loadImage(pngURL.href);

  let map;
  try {
    const res = await fetch(jsonURL.href);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${jsonURL.href}`);
    map = await res.json();
  } catch (err) {
    throw new Error(`[mochi] failed to load framemap.json: ${err.message}`);
  }

  if (!map || typeof map !== 'object' || !map.animations || !map.effects) {
    throw new Error('[mochi] framemap.json is missing "animations" or "effects"');
  }
  if (map.meta && map.meta.tile !== 32) {
    console.warn(`[mochi] unexpected tile size ${map.meta.tile} (expected 32)`);
  }
  for (const name of KNOWN_ANIMATIONS) {
    if (!map.animations[name]) console.warn(`[mochi] framemap.json missing animation: "${name}"`);
  }
  for (const name of KNOWN_EFFECTS) {
    if (!map.effects[name]) console.warn(`[mochi] framemap.json missing effect: "${name}"`);
  }

  return { img, map };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    img.onload = () => done(resolve, img);
    img.onerror = () => done(reject, new Error(`[mochi] failed to load image: ${src}`));
    img.src = src;
    // decode() is faster where available; onload stays as the fallback.
    if (typeof img.decode === 'function') {
      img.decode().then(() => done(resolve, img), () => {});
    }
  });
}
