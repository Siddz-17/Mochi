// src/extras/reminders.js
// Gentle stretch + water reminders on a configurable interval, plus a
// one-time greeting on boot. Reminders surface as pixel speech bubbles via
// the effects layer (with a DOM fallback). All data stays local.

/** Show a speech bubble through the effects module, with a DOM fallback. */
function showBubble(deps, text) {
  const effects = deps.effects;
  try {
    if (effects && typeof effects.bubble === 'function') {
      effects.bubble(text);
      return;
    }
    if (effects && typeof effects.say === 'function') {
      effects.say(text);
      return;
    }
  } catch (_) {
    /* fall through to DOM fallback */
  }
  const layer = document.getElementById('effects-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.textContent = text;
  el.className = 'mochi-bubble'; // CSP-safe: styles live in styles.css
  layer.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

/**
 * @param {Object} deps
 * @param {Object} [deps.bridge]    - window.mochi bridge (unused today, kept for parity)
 * @param {Object} [deps.effects]   - effects module ({ bubble(text) })
 * @param {Function} [deps.getConfig] - () => current config object
 * @param {Object} [deps.sound]     - sound module ({ pop() }), optional
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createReminders(deps = {}) {
  const getConfig =
    typeof deps.getConfig === 'function' ? deps.getConfig : () => ({});

  /** @type {Array<ReturnType<typeof setTimeout>>} */
  let timers = [];
  let greeted = false;

  function say(text) {
    showBubble(deps, text);
    try {
      if (deps.sound && typeof deps.sound.pop === 'function') deps.sound.pop();
    } catch (_) {
      /* sounds are best-effort */
    }
  }

  function clearAll() {
    for (const id of timers) {
      clearInterval(id);
      clearTimeout(id);
    }
    timers = [];
  }

  function start() {
    clearAll();
    const cfg = getConfig();
    const r = cfg.reminders || {};
    const intervalMs = Math.max(1, r.intervalMinutes ?? 45) * 60 * 1000;

    // One-time greeting on boot.
    if (!greeted) {
      greeted = true;
      const name =
        (cfg.userName && String(cfg.userName).trim()) || 'friend';
      setTimeout(() => say(`Hi ${name}!`), 1500);
    }

    if (r.stretch) {
      timers.push(setInterval(() => say('Stretch time! 🐾'), intervalMs));
    }
    if (r.water) {
      // Stagger the water reminder by half an interval so both reminders
      // never pop at the exact same moment.
      const offset = Math.floor(intervalMs / 2);
      timers.push(
        setTimeout(function waterTick() {
          say('Water break! 💧');
          timers.push(setInterval(() => say('Water break! 💧'), intervalMs));
        }, offset),
      );
    }
  }

  function stop() {
    clearAll();
  }

  return { start, stop };
}
