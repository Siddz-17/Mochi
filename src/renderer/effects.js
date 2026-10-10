/**
 * effects.js — transient pixel-art overlay effects for Mochi.
 *
 * Public API:
 *   createEffects(layerEl, sprites) -> {
 *     show(name, { x, y, ms, loop, scale, static }),
 *     clear(name),
 *     clearAll(),
 *     setScale(n)            // extra: keep effects crisp when dog scale changes
 *   }
 *
 * - `layerEl` is the overlay container (the `#effects-layer` element).
 * - `sprites` is `{ img, map }` from spriteLoader.loadSprites(); effect frames
 *   come from `map.effects[name]` = { loop, frames: [{x,y,w,h,durationMs}] }.
 * - Each shown effect gets its own absolutely-positioned <canvas> with
 *   image-rendering: pixelated, drawn at integer scale (default 4, or the
 *   `scale` option / last setScale value).
 * - `show` replaces any existing effect with the same name.
 * - `ms`: auto-remove after this many milliseconds. Omit (or pass null) and
 *   the effect persists until clear(name)/clearAll() — useful for looping
 *   indicators like `ellipsis` while the agent thinks.
 * - `loop: true` forces looping even if the map says the effect doesn't loop.
 * - `static: true` draws the first frame once with no timers (zero CPU) —
 *   used for e.g. `zzz` while the dog sleeps.
 * - `x`/`y` are CSS pixels relative to the layer; when omitted the effect is
 *   horizontally centered near the top of the layer.
 *
 * Frame timing honors each frame's durationMs via chained setTimeout (no rAF),
 * so idle effects cost nothing once removed. Unknown effect names warn and
 * return null instead of throwing.
 */

export function createEffects(layerEl, sprites) {
  if (!layerEl) throw new Error('[mochi] createEffects requires a layer element');
  if (!sprites || !sprites.img || !sprites.map || !sprites.map.effects) {
    throw new Error('[mochi] createEffects requires { img, map } with map.effects');
  }

  let scale = 4;
  /** name -> { name, fx, canvas, index, s, ox, oy, timer, frameTimer } */
  const active = new Map();

  function drawFrame(entry) {
    const f = entry.fx.frames[entry.index];
    const ctx = entry.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    ctx.drawImage(sprites.img, f.x, f.y, f.w, f.h, 0, 0, f.w * entry.s, f.h * entry.s);
  }

  function layout(entry) {
    const f = entry.fx.frames[0];
    entry.canvas.width = Math.max(1, Math.round(f.w * entry.s));
    entry.canvas.height = Math.max(1, Math.round(f.h * entry.s));
    const W = layerEl.clientWidth || 128;
    const x = entry.ox != null ? entry.ox : Math.round((W - entry.canvas.width) / 2);
    const y = entry.oy != null ? entry.oy : 2;
    entry.canvas.style.left = `${x}px`;
    entry.canvas.style.top = `${y}px`;
    drawFrame(entry);
  }

  function show(name, opts = {}) {
    const fx = sprites.map.effects[name];
    if (!fx || !Array.isArray(fx.frames) || fx.frames.length === 0) {
      console.warn(`[mochi] unknown effect: "${name}"`);
      return null;
    }
    clear(name);

    const canvas = document.createElement('canvas');
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    canvas.style.imageRendering = 'pixelated';
    canvas.setAttribute('data-effect', name);

    const entry = {
      name,
      fx,
      canvas,
      index: 0,
      s: opts.scale || scale,
      ox: opts.x != null ? opts.x : null,
      oy: opts.y != null ? opts.y : null,
      timer: null,
      frameTimer: null,
    };
    layout(entry);
    layerEl.appendChild(canvas);
    active.set(name, entry);

    if (!opts.static) {
      const step = () => {
        entry.frameTimer = null;
        entry.index += 1;
        if (entry.index >= fx.frames.length) {
          if (fx.loop || opts.loop) {
            entry.index = 0;
          } else {
            clear(name);
            return;
          }
        }
        drawFrame(entry);
        const dur = Math.max(16, fx.frames[entry.index].durationMs || 120);
        entry.frameTimer = setTimeout(step, dur);
      };
      const firstDur = Math.max(16, fx.frames[0].durationMs || 120);
      entry.frameTimer = setTimeout(step, firstDur);
    }

    if (opts.ms != null) {
      entry.timer = setTimeout(() => clear(name), opts.ms);
    }
    return entry;
  }

  function clear(name) {
    const entry = active.get(name);
    if (!entry) return;
    active.delete(name);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.frameTimer) clearTimeout(entry.frameTimer);
    entry.canvas.remove();
  }

  function clearAll() {
    for (const name of [...active.keys()]) clear(name);
  }

  function setScale(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n) || n < 1) return;
    scale = n;
    for (const entry of active.values()) {
      entry.s = n;
      layout(entry);
    }
  }

  return { show, clear, clearAll, setScale };
}
