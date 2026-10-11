/**
 * onboarding.js — first-run welcome bubble (Phase C, "dog life+").
 *
 * maybeShowOnboarding({ bridge, getConfig, dog }) shows a small pixel-styled
 * speech bubble near the dog exactly once per user:
 *
 *   - Trigger: the renderer-localStorage flag `mochi.onboarded`. (Never the
 *     main-process position.json — main.cjs is off-limits.)
 *   - Step 0 asks the user's name (prefilled from config.userName when set)
 *     and saves it via the existing bridge.setConfig({ userName }).
 *   - Steps 1-3 are a mini tour: drag me anywhere / click me to chat /
 *     tray icon for settings & quit.
 *   - A "Skip" button dismisses at any point; the flow never shows again.
 *
 * While the bubble is up, dog.setUiOverlay(true) quiets the dog's hover
 * antics and keeps the window mouse-active so the bubble stays clickable;
 * dragging the dog keeps working (it's tour step 1).
 *
 * Returns a { dismiss, el } handle, or null when the flag is already set.
 * Never throws: boot wraps this call so onboarding can never break launch.
 */

const FLAG = 'mochi.onboarded';

const STEPS = [
  {
    title: "Hi! I'm Mochi!",
    body: "Your little desktop buddy. What should I call you?",
    name: true,
    cta: "Let's go!",
  },
  {
    title: '1 · Drag me anywhere',
    body: 'Grab me with the mouse and drop me wherever you like on your screen.',
    cta: 'Next',
  },
  {
    title: '2 · Click me to chat',
    body: 'A quick click opens the chat panel. Ask me anything!',
    cta: 'Next',
  },
  {
    title: '3 · Tray icon',
    body: 'The tray icon has settings, sleep, and quit. Have fun!',
    cta: 'Done!',
  },
];

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function maybeShowOnboarding(opts = {}) {
  const bridge = opts.bridge || {};
  const dog = opts.dog || {};
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});

  let seen = false;
  try {
    seen = !!localStorage.getItem(FLAG);
  } catch {
    seen = true; // storage unavailable: fail closed, never nag
  }
  if (seen) return null;
  try {
    localStorage.setItem(FLAG, '1'); // shown exactly once, even if dismissed
  } catch {
    /* non-fatal */
  }

  let cfg = {};
  try {
    cfg = getConfig() || {};
  } catch {
    /* keep empty */
  }

  // Position the bubble just right of the dog canvas, falling back below it
  // if the window is too narrow. (Window is 560x480; dog sits top-left.)
  let left = 148, top = 8;
  try {
    const cv = document.getElementById('dog-canvas');
    const r = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
    const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 560;
    if (r) {
      if (r.right + 12 + 264 <= w) {
        left = Math.round(r.right + 12);
        top = Math.round(r.top + 4);
      } else {
        left = 8;
        top = Math.round(r.bottom + 12);
      }
    }
  } catch {
    /* keep defaults */
  }

  const root = el('div', 'mochi-onboarding');
  try {
    root.style.left = left + 'px';
    root.style.top = top + 'px';
  } catch {
    /* static CSS fallback */
  }
  const titleEl = el('div', 'mob-title');
  const bodyEl = el('div', 'mob-body');
  const input = document.createElement('input');
  input.className = 'mob-name';
  input.type = 'text';
  input.placeholder = 'Your name…';
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Your name');
  try {
    if (cfg.userName) input.value = String(cfg.userName);
  } catch {
    /* keep empty */
  }
  const row = el('div', 'mob-row');
  const skipBtn = el('button', 'mob-skip', 'Skip');
  skipBtn.type = 'button';
  const dotsEl = el('span', 'mob-dots');
  const nextBtn = el('button', 'mob-next');
  nextBtn.type = 'button';
  row.appendChild(skipBtn);
  row.appendChild(dotsEl);
  row.appendChild(nextBtn);
  root.appendChild(titleEl);
  root.appendChild(bodyEl);
  root.appendChild(input);
  root.appendChild(row);

  let step = 0;
  let dismissed = false;

  function saveName() {
    let name = '';
    try {
      name = String(input.value || '').trim();
    } catch {
      /* ignore */
    }
    if (name && typeof bridge.setConfig === 'function') {
      try {
        bridge.setConfig({ userName: name });
      } catch {
        /* non-fatal */
      }
    }
  }

  function render() {
    const s = STEPS[step];
    titleEl.textContent = s.title;
    bodyEl.textContent = s.body;
    input.style.display = s.name ? '' : 'none';
    nextBtn.textContent = s.cta;
    dotsEl.textContent = STEPS.map((_, i) => (i === step ? '●' : '○')).join(' ');
  }

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    saveName();
    try {
      root.remove();
    } catch {
      /* ignore */
    }
    try {
      if (typeof dog.setUiOverlay === 'function') dog.setUiOverlay(false);
    } catch {
      /* ignore */
    }
  }

  function next() {
    if (dismissed) return;
    if (step === 0) saveName();
    step += 1;
    if (step >= STEPS.length) dismiss();
    else render();
  }

  nextBtn.addEventListener('click', next);
  skipBtn.addEventListener('click', dismiss);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') next();
    else if (e.key === 'Escape') dismiss();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });

  try {
    document.body.appendChild(root);
  } catch {
    return null; // no DOM to attach to
  }
  try {
    if (typeof dog.setUiOverlay === 'function') dog.setUiOverlay(true);
  } catch {
    /* ignore */
  }
  render();
  try {
    if (STEPS[0].name) input.focus();
  } catch {
    /* ignore */
  }

  return { dismiss, el: root };
}
