// src/extras/pomodoro.js
// Tiny pixel Pomodoro timer rendered as an absolutely-positioned chip near
// the dog. Focus/break lengths come from config; on each transition it shows
// a pixel speech bubble via the effects layer and plays an optional blip.
// The countdown pauses while the document is hidden (visibilitychange).

const TICK_MS = 500;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

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

function playSound(deps, name) {
  const sound = deps.sound;
  try {
    if (sound && typeof sound[name] === 'function') sound[name]();
  } catch (_) {
    /* sounds are best-effort */
  }
}

/**
 * @param {Object} deps
 * @param {Object} deps.bridge  - window.mochi bridge (unused today, kept for parity)
 * @param {Object} deps.effects - effects module ({ bubble(text) })
 * @param {Object} deps.dog     - dog module (unused today, kept for parity)
 * @param {Function} deps.getConfig - () => current config object
 * @param {Object} [deps.sound] - sound module ({ pop() })
 * @returns {{ start: () => boolean, stop: () => void, toggle: () => boolean,
 *             getState: () => { phase: string, running: boolean, remainingMs: number } }}
 */
export function createPomodoro(deps = {}) {
  const getConfig =
    typeof deps.getConfig === 'function' ? deps.getConfig : () => ({});

  let container = null;
  let labelEl = null;
  let timeEl = null;
  let phase = 'idle'; // 'idle' | 'focus' | 'break'
  let timerId = null;
  let endAt = 0;
  let pausedRemainingMs = 0;

  function ensureContainer() {
    if (container) return container;
    const stage =
      document.getElementById('stage') || document.body;
    container = document.createElement('div');
    container.className = 'mochi-pomodoro';
    container.title = 'Pomodoro — click to stop';
    // Static styling lives in .mochi-pomodoro (styles.css) for CSP.

    labelEl = document.createElement('span');
    labelEl.className = 'mochi-pomodoro-label';
    timeEl = document.createElement('span');
    container.appendChild(labelEl);
    container.appendChild(timeEl);
    container.addEventListener('click', () => stop());
    stage.appendChild(container);
    return container;
  }

  function render() {
    ensureContainer();
    if (phase === 'idle') {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    labelEl.textContent = phase === 'focus' ? 'FOCUS' : 'BREAK';
    timeEl.textContent = formatMs(Math.max(0, endAt - Date.now()));
  }

  function clearTimer() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  function beginPhase(nextPhase, durationMs) {
    phase = nextPhase;
    endAt = Date.now() + durationMs;
    pausedRemainingMs = 0;
    clearTimer();
    timerId = setInterval(onTick, TICK_MS);
    render();
  }

  function onTick() {
    const remaining = endAt - Date.now();
    if (remaining <= 0) {
      const pomo = getConfig().pomodoro || {};
      if (phase === 'focus') {
        showBubble(deps, 'Break time! Stretch those paws 🐾');
        playSound(deps, 'pop');
        beginPhase(
          'break',
          Math.max(1, pomo.breakMinutes ?? 5) * 60 * 1000,
        );
      } else {
        showBubble(deps, 'Focus time! You got this 💪');
        playSound(deps, 'pop');
        beginPhase(
          'focus',
          Math.max(1, pomo.focusMinutes ?? 25) * 60 * 1000,
        );
      }
      return;
    }
    render();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      // Pause the countdown while hidden.
      if (phase !== 'idle' && timerId !== null) {
        pausedRemainingMs = Math.max(0, endAt - Date.now());
        clearTimer();
      }
    } else if (phase !== 'idle' && timerId === null && pausedRemainingMs > 0) {
      // Resume where we left off.
      endAt = Date.now() + pausedRemainingMs;
      pausedRemainingMs = 0;
      timerId = setInterval(onTick, TICK_MS);
      render();
    }
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function start() {
    const pomo = getConfig().pomodoro || {};
    if (pomo.enabled === false) return false;
    if (phase !== 'idle') return true;
    beginPhase(
      'focus',
      Math.max(1, pomo.focusMinutes ?? 25) * 60 * 1000,
    );
    showBubble(deps, 'Pomodoro started — focus! 🍅');
    return true;
  }

  function stop() {
    clearTimer();
    phase = 'idle';
    pausedRemainingMs = 0;
    if (container) container.style.display = 'none';
  }

  function toggle() {
    if (phase === 'idle') return start();
    stop();
    return false;
  }

  function getState() {
    return {
      phase,
      running: phase !== 'idle',
      remainingMs:
        phase === 'idle'
          ? 0
          : timerId !== null
            ? Math.max(0, endAt - Date.now())
            : pausedRemainingMs,
    };
  }

  return { start, stop, toggle, getState };
}
