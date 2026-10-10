// src/renderer/settings.js
// Tiny settings window for Mochi: dog size, my name, wander on/off,
// and "Connect AI provider (not connected yet)".

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {HTMLElement} rootEl - the #settings container
 * @param {Object} deps
 * @param {Object} deps.bridge    - window.mochi bridge
 * @param {Object} deps.dog       - dog module ({ setSize(px) })
 * @param {Function} deps.getConfig - () => current config object
 * @returns {{ open: () => void, close: () => void, toggle: () => void }}
 */
export function createSettings(rootEl, deps = {}) {
  const { bridge = {}, dog = {}, getConfig } = deps;
  const readConfig = typeof getConfig === 'function' ? getConfig : () => ({});

  rootEl.classList.add('mset-backdrop');
  rootEl.innerHTML = `
    <div class="mset-card" role="dialog" aria-label="Mochi Settings">
      <div class="mset-head">
        <h2>⚙ Settings</h2>
        <button type="button" class="mset-x" data-act="close" aria-label="Close">✕</button>
      </div>
      <form id="settings-form" class="mset-body">
        <div class="mset-row">
          <label for="mset-size">Dog size</label>
          <div class="mset-range-row">
            <input id="mset-size" class="mset-range" type="range" data-f="dogSize"
              min="80" max="200" step="5" value="120">
            <span id="mset-size-val" class="mset-val">120px</span>
          </div>
        </div>

        <div class="mset-row">
          <label for="mset-name">My name</label>
          <input id="mset-name" class="mset-text" type="text" data-f="userName"
            placeholder="Your name" maxlength="40" autocomplete="off">
        </div>

        <div class="mset-row mset-check-row">
          <label for="mset-wander">Wander around screen</label>
          <input id="mset-wander" class="mset-check" type="checkbox" data-f="wanderEnabled">
        </div>

        <div class="mset-row mset-check-row">
          <label for="mset-calm">Calm mode (subtle animations)</label>
          <input id="mset-calm" class="mset-check" type="checkbox" data-f="calmMode">
        </div>

        <div class="mset-provider-box">
          <button type="button" class="mset-provider-btn" disabled>
            🔗 Connect AI provider (not connected yet)
          </button>
          <p class="mset-hint">Currently running offline with built-in companion responses.</p>
        </div>
      </form>
    </div>
  `;

  const card = rootEl.querySelector('.mset-card');
  const form = rootEl.querySelector('#settings-form');
  const sizeInput = rootEl.querySelector('#mset-size');
  const sizeVal = rootEl.querySelector('#mset-size-val');

  let isOpen = false;

  function updateSizeDisplay(val) {
    if (sizeVal) sizeVal.textContent = `${val}px`;
  }

  function populate(cfg) {
    const c = cfg || {};
    const scale = c.scale || (c.dogSize ? Math.round(c.dogSize / 32) : 4);
    const size = clampNum(scale * 32, 64, 192, 128);
    if (sizeInput) {
      sizeInput.value = size;
      updateSizeDisplay(size);
    }
    const nameInput = rootEl.querySelector('#mset-name');
    if (nameInput) nameInput.value = c.userName || '';

    const wanderInput = rootEl.querySelector('#mset-wander');
    if (wanderInput) wanderInput.checked = c.wanderEnabled !== false;

    const calmInput = rootEl.querySelector('#mset-calm');
    if (calmInput) calmInput.checked = !!c.calmMode;
  }

  function readForm() {
    const patch = {};
    if (sizeInput) {
      const val = clampNum(sizeInput.value, 64, 192, 128);
      patch.dogSize = val;
      patch.scale = Math.max(2, Math.min(6, Math.round(val / 32)));
    }

    const nameInput = rootEl.querySelector('#mset-name');
    if (nameInput) patch.userName = nameInput.value.trim();

    const wanderInput = rootEl.querySelector('#mset-wander');
    if (wanderInput) patch.wanderEnabled = wanderInput.checked;

    const calmInput = rootEl.querySelector('#mset-calm');
    if (calmInput) patch.calmMode = calmInput.checked;

    return patch;
  }

  async function save() {
    const patch = readForm();
    if (typeof bridge.setConfig === 'function') {
      try {
        await bridge.setConfig(patch);
      } catch (err) {
        console.warn('[mochi] failed to save settings:', err);
      }
    }
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    populate(readConfig());
    rootEl.classList.remove('hidden');
    rootEl.classList.add('mset-open');
    if (typeof bridge.focusWindow === 'function') {
      try { bridge.focusWindow(); } catch {}
    }
    if (typeof bridge.setIgnoreMouseEvents === 'function') {
      try { bridge.setIgnoreMouseEvents(false); } catch {}
    }
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    save();
    rootEl.classList.add('hidden');
    rootEl.classList.remove('mset-open');
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // Interactive events
  if (sizeInput) {
    sizeInput.addEventListener('input', (e) => {
      const val = e.target.value;
      updateSizeDisplay(val);
      if (dog && typeof dog.setSize === 'function') {
        dog.setSize(val);
      }
    });
    sizeInput.addEventListener('change', () => save());
  }

  const nameInput = rootEl.querySelector('#mset-name');
  if (nameInput) {
    nameInput.addEventListener('change', () => save());
  }

  const wanderInput = rootEl.querySelector('#mset-wander');
  if (wanderInput) {
    wanderInput.addEventListener('change', () => save());
  }

  const calmInput = rootEl.querySelector('#mset-calm');
  if (calmInput) {
    calmInput.addEventListener('change', (e) => {
      if (dog && typeof dog.setCalmMode === 'function') {
        dog.setCalmMode(e.target.checked);
      }
      save();
    });
  }

  const closeBtn = rootEl.querySelector('.mset-x');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
  }

  rootEl.addEventListener('click', (e) => {
    if (e.target === rootEl) close();
  });

  if (typeof bridge.onOpenSettings === 'function') {
    bridge.onOpenSettings(() => open());
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => isOpen,
  };
}
