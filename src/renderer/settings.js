// src/renderer/settings.js
// Pixel-styled settings form for Mochi.
// Mounted into #settings (rootEl). Reads the current config via
// deps.getConfig(), persists with bridge.setConfig(patch).
//
// NOTE: styles live in src/renderer/settings.css (class prefix `mset-`),
// linked from index.html. They reuse the shared CSS vars
// --ink / --paper / --accent when they exist.

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {HTMLElement} rootEl - the #settings container
 * @param {Object} deps
 * @param {Object} deps.bridge    - window.mochi bridge
 * @param {Object} deps.dog       - dog module ({ setPeekMode(on) })
 * @param {Function} deps.getConfig - () => current config object
 * @returns {{ open: () => void, close: () => void, toggle: () => void }}
 */
export function createSettings(rootEl, deps = {}) {
  const { bridge = {}, dog = {}, getConfig } = deps;
  const readConfig =
    typeof getConfig === 'function' ? getConfig : () => ({});


  rootEl.classList.add('mset-backdrop');
  rootEl.innerHTML = `
    <div class="mset-card" role="dialog" aria-label="Mochi settings">
      <div class="mset-head">
        <h2>⚙ SETTINGS</h2>
        <button type="button" class="mset-x" data-act="close" aria-label="Close">✕</button>
      </div>
      <form id="settings-form" class="mset-body">
        <fieldset class="mset-group">
          <legend>YOU</legend>
          <div class="mset-row">
            <label for="mset-name">Your name</label>
            <input id="mset-name" class="mset-text" type="text" data-f="userName"
              placeholder="friend" maxlength="40" autocomplete="off">
          </div>
          <p class="mset-hint">Mochi greets you by this name on boot.</p>
        </fieldset>

        <fieldset class="mset-group">
          <legend>DOG</legend>
          <div class="mset-row">
            <label for="mset-scale">Sprite scale</label>
            <input id="mset-scale" class="mset-num" type="number" data-f="scale"
              min="2" max="6" step="1">
          </div>
          <div class="mset-row">
            <label for="mset-calm">Calm mode <span class="mset-hint">(fewer animations)</span></label>
            <input id="mset-calm" class="mset-check" type="checkbox" data-f="calmMode">
          </div>
          <div class="mset-row">
            <label for="mset-peek">Peek mode <span class="mset-hint">(dog peeks from screen edge)</span></label>
            <input id="mset-peek" class="mset-check" type="checkbox" data-f="peekMode">
          </div>
          <div class="mset-row">
            <label for="mset-ontop">Always on top <span class="mset-hint">(off = lives on the desktop, under your apps)</span></label>
            <input id="mset-ontop" class="mset-check" type="checkbox" data-f="alwaysOnTop">
          </div>
          <div class="mset-row">
            <label for="mset-sleep">Sleep after (minutes idle)</label>
            <input id="mset-sleep" class="mset-num" type="number" data-f="sleepAfterMinutes"
              min="1" max="120" step="1">
          </div>
        </fieldset>

        <fieldset class="mset-group">
          <legend>SOUND</legend>
          <div class="mset-row">
            <label for="mset-sounds">Enable sounds</label>
            <input id="mset-sounds" class="mset-check" type="checkbox" data-f="soundsEnabled">
          </div>
          <p class="mset-hint">Muted by default. 8-bit blips only — no music.</p>
        </fieldset>

        <fieldset class="mset-group">
          <legend>SYSTEM</legend>
          <div class="mset-row">
            <label for="mset-login">Launch at login</label>
            <input id="mset-login" class="mset-check" type="checkbox" data-f="openAtLogin">
          </div>
          <div class="mset-row">
            <label for="mset-autoupdate">Auto-update <span class="mset-hint">(via GitHub Releases)</span></label>
            <input id="mset-autoupdate" class="mset-check" type="checkbox" data-f="autoUpdate">
          </div>
          <p class="mset-hint">Opt-in. When on, Mochi checks for updates at launch and
            every 6 hours. Off by default — zero network while off.</p>
          <div class="mset-row">
            <label for="mset-folder">Working folder</label>
            <input id="mset-folder" class="mset-text" type="text" data-f="workingFolder"
              placeholder="/path/to/project" spellcheck="false" autocomplete="off">
          </div>
          <div class="mset-row">
            <label for="mset-hotkey">Toggle panel hotkey</label>
            <button type="button" id="mset-hotkey" class="mset-kbd mset-hotkey-btn"
              title="Click, then press your key combo">…</button>
          </div>
          <p class="mset-hint">Click the combo, then press your keys. Esc cancels.</p>
          <p class="mset-msg" id="mset-hotkey-msg" hidden></p>
        </fieldset>

        <fieldset class="mset-group">
          <legend>POMODORO</legend>
          <div class="mset-row">
            <label for="mset-pomo-on">Enabled</label>
            <input id="mset-pomo-on" class="mset-check" type="checkbox" data-f="pomodoro.enabled">
          </div>
          <div class="mset-row">
            <label for="mset-pomo-focus">Focus (minutes)</label>
            <input id="mset-pomo-focus" class="mset-num" type="number" data-f="pomodoro.focusMinutes"
              min="1" max="180" step="1">
          </div>
          <div class="mset-row">
            <label for="mset-pomo-break">Break (minutes)</label>
            <input id="mset-pomo-break" class="mset-num" type="number" data-f="pomodoro.breakMinutes"
              min="1" max="60" step="1">
          </div>
        </fieldset>

        <fieldset class="mset-group">
          <legend>REMINDERS</legend>
          <div class="mset-row">
            <label for="mset-rem-stretch">Stretch reminders</label>
            <input id="mset-rem-stretch" class="mset-check" type="checkbox" data-f="reminders.stretch">
          </div>
          <div class="mset-row">
            <label for="mset-rem-water">Water reminders</label>
            <input id="mset-rem-water" class="mset-check" type="checkbox" data-f="reminders.water">
          </div>
          <div class="mset-row">
            <label for="mset-rem-interval">Every (minutes)</label>
            <input id="mset-rem-interval" class="mset-num" type="number" data-f="reminders.intervalMinutes"
              min="5" max="240" step="1">
          </div>
        </fieldset>

        <fieldset class="mset-group" disabled aria-disabled="true">
          <legend>CONNECT AI PROVIDER <span class="mset-badge">NOT CONNECTED YET</span></legend>
          <div class="mset-row">
            <label for="mset-prov-id">Provider</label>
            <input id="mset-prov-id" class="mset-text" type="text" value="mock" disabled>
          </div>
          <div class="mset-row">
            <label for="mset-prov-key">API key</label>
            <input id="mset-prov-key" class="mset-text" type="password"
              placeholder="Unavailable" disabled autocomplete="off">
          </div>
          <p class="mset-note">🔌 Provider support isn't wired up in this build — Mochi runs
            on the local mock provider. To plug in a real AI provider later, see
            <code>docs/ADD_A_PROVIDER.md</code>.</p>
        </fieldset>
      </form>
      <div class="mset-foot">
        <button type="button" class="mset-btn" data-act="close">CANCEL</button>
        <button type="button" class="mset-btn mset-btn-primary" data-act="save">SAVE</button>
      </div>
    </div>`;

  const form = rootEl.querySelector('#settings-form');

  function field(key) {
    return form.querySelector(`[data-f="${key}"]`);
  }

  /* ---------- customizable panel hotkey (record combo) ---------- */

  const hotkeyBtn = rootEl.querySelector('#mset-hotkey');
  const hotkeyMsg = rootEl.querySelector('#mset-hotkey-msg');
  const FALLBACK_HOTKEY = 'CmdOrCtrl+Shift+M';
  let recording = false;

  function currentHotkey() {
    const c = readConfig();
    const h = c && typeof c.panelHotkey === 'string' ? c.panelHotkey.trim() : '';
    return h || FALLBACK_HOTKEY;
  }

  // "CmdOrCtrl+Shift+M" -> "Cmd+Shift+M" (macOS) / "Ctrl+Shift+M" (elsewhere).
  function formatAccelerator(acc) {
    const ctrlLabel = bridge && bridge.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    return String(acc || FALLBACK_HOTKEY).replace(
      /CmdOrCtrl|CommandOrControl/g,
      ctrlLabel
    );
  }

  function showHotkeyMsg(text, isError) {
    if (!hotkeyMsg) return;
    hotkeyMsg.textContent = text;
    hotkeyMsg.hidden = false;
    hotkeyMsg.classList.toggle('mset-msg-error', !!isError);
  }

  function hideHotkeyMsg() {
    if (!hotkeyMsg) return;
    hotkeyMsg.hidden = true;
    hotkeyMsg.textContent = '';
  }

  // Keydown event -> Electron accelerator ("Control+Shift+M").
  // Returns null for modifier-only presses or unusable keys (keep listening).
  // Requires at least one modifier: global single-key shortcuts steal typing.
  function eventToAccelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.metaKey) mods.push('Command');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    else if (/^F\d{1,2}$/.test(key)) {
      /* F1..F24 pass through unchanged */
    } else {
      const named = {
        Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
        Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp',
        PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
        ArrowLeft: 'Left', ArrowRight: 'Right',
      };
      key = named[key] || null;
    }
    if (!key || mods.length === 0) return null;
    return [...mods, key].join('+');
  }

  function stopRecording(restoreLabel) {
    if (!recording) return;
    recording = false;
    window.removeEventListener('keydown', onRecordKeydown, true);
    if (hotkeyBtn) {
      hotkeyBtn.classList.remove('mset-recording');
      if (restoreLabel !== false) {
        hotkeyBtn.textContent = formatAccelerator(currentHotkey());
      }
    }
  }

  async function applyRecordedCombo(acc) {
    recording = false;
    window.removeEventListener('keydown', onRecordKeydown, true);
    if (hotkeyBtn) {
      hotkeyBtn.classList.remove('mset-recording');
      hotkeyBtn.textContent = '…';
    }
    try {
      if (typeof bridge.setPanelHotkey !== 'function') {
        throw new Error('hotkey bridge unavailable');
      }
      const res = await bridge.setPanelHotkey(acc);
      const applied =
        res && typeof res.hotkey === 'string' ? res.hotkey : currentHotkey();
      if (hotkeyBtn) hotkeyBtn.textContent = formatAccelerator(applied);
      if (res && res.ok) {
        showHotkeyMsg(`Panel hotkey set to ${formatAccelerator(applied)}.`, false);
      } else {
        // Main kept the old hotkey registered; surface why the combo failed.
        showHotkeyMsg((res && res.error) || 'Could not register that combo.', true);
      }
    } catch (_) {
      if (hotkeyBtn) hotkeyBtn.textContent = formatAccelerator(currentHotkey());
      showHotkeyMsg('Could not register that combo.', true);
    }
  }

  function onRecordKeydown(e) {
    e.preventDefault();
    e.stopPropagation(); // keep Esc from closing the dialog while recording
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    const acc = eventToAccelerator(e);
    if (!acc) return; // modifier-only press — keep listening
    applyRecordedCombo(acc);
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    hideHotkeyMsg();
    if (hotkeyBtn) {
      hotkeyBtn.classList.add('mset-recording');
      hotkeyBtn.textContent = 'press keys…';
      hotkeyBtn.focus({ preventScroll: true });
    }
    window.addEventListener('keydown', onRecordKeydown, true);
  }

  if (hotkeyBtn) {
    hotkeyBtn.addEventListener('click', () => {
      if (recording) stopRecording();
      else startRecording();
    });
  }

  function fillFromConfig() {
    const c = readConfig();
    const pomo = c.pomodoro || {};
    const rem = c.reminders || {};
    const values = {
      userName: c.userName ?? '',
      scale: c.scale ?? 4,
      calmMode: !!c.calmMode,
      peekMode: !!c.peekMode,
      sleepAfterMinutes: c.sleepAfterMinutes ?? 5,
      soundsEnabled: !!c.soundsEnabled,
      openAtLogin: !!c.openAtLogin,
      autoUpdate: !!c.autoUpdate,
      workingFolder: c.workingFolder ?? '',
      'pomodoro.enabled': !!pomo.enabled,
      'pomodoro.focusMinutes': pomo.focusMinutes ?? 25,
      'pomodoro.breakMinutes': pomo.breakMinutes ?? 5,
      'reminders.stretch': rem.stretch ?? true,
      'reminders.water': rem.water ?? true,
      'reminders.intervalMinutes': rem.intervalMinutes ?? 45,
    };
    for (const [key, value] of Object.entries(values)) {
      const el = field(key);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = value;
    }
  }

  function collectPatch() {
    const pomo = readConfig().pomodoro || {};
    const rem = readConfig().reminders || {};
    const patch = {
      userName: String(field('userName').value).trim(),
      scale: clampInt(field('scale').value, 2, 6, 4),
      calmMode: field('calmMode').checked,
      peekMode: field('peekMode').checked,
      sleepAfterMinutes: clampInt(field('sleepAfterMinutes').value, 1, 120, 5),
      soundsEnabled: field('soundsEnabled').checked,
      openAtLogin: field('openAtLogin').checked,
      workingFolder: String(field('workingFolder').value).trim(),
      pomodoro: {
        ...pomo,
        enabled: field('pomodoro.enabled').checked,
        focusMinutes: clampInt(field('pomodoro.focusMinutes').value, 1, 180, 25),
        breakMinutes: clampInt(field('pomodoro.breakMinutes').value, 1, 60, 5),
      },
      reminders: {
        ...rem,
        stretch: field('reminders.stretch').checked,
        water: field('reminders.water').checked,
        intervalMinutes: clampInt(field('reminders.intervalMinutes').value, 5, 240, 45),
      },
    };
    return patch;
  }

  function applyLive(key) {
    // Peek mode applies to the dog immediately on toggle.
    if (key === 'peekMode' && dog && typeof dog.setPeekMode === 'function') {
      try {
        dog.setPeekMode(field('peekMode').checked);
      } catch (_) {
        /* best effort */
      }
    }
  }

  function save() {
    const patch = collectPatch();
    try {
      // autoUpdate goes through the dedicated opt-in bridge (Phase A
      // contract) so the updater starts/stops immediately; it is excluded
      // from the generic patch so it is never written twice.
      if (typeof bridge.setAutoUpdate === 'function') {
        bridge.setAutoUpdate(!!field('autoUpdate').checked);
      }
      if (typeof bridge.setConfig === 'function') bridge.setConfig(patch);
      if (typeof bridge.setOpenAtLogin === 'function') {
        bridge.setOpenAtLogin(!!patch.openAtLogin);
      }
      applyLive('peekMode');
    } catch (_) {
      /* bridge errors are surfaced by the main process; keep quiet here */
    }
    close();
  }

  function open() {
    fillFromConfig();
    stopRecording(false);
    hideHotkeyMsg();
    if (hotkeyBtn) hotkeyBtn.textContent = formatAccelerator(currentHotkey());
    rootEl.classList.add('mset-open');
    const first = form.querySelector('input:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  function close() {
    stopRecording(false);
    rootEl.classList.remove('mset-open');
  }

  function toggle() {
    if (rootEl.classList.contains('mset-open')) close();
    else open();
  }

  rootEl.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    // Clicking the dimmed backdrop (not the card) also closes.
    if (e.target === rootEl) {
      close();
      return;
    }
    if (!act) return;
    if (act.dataset.act === 'save') save();
    else if (act.dataset.act === 'close') close();
  });

  form.addEventListener('change', (e) => {
    const el = e.target.closest('[data-f]');
    if (el && el.dataset.f === 'peekMode') applyLive('peekMode');
  });

  rootEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // Keep the form in sync if the renderer wires the tray/menu open action.
  try {
    if (typeof bridge.onOpenSettings === 'function') {
      bridge.onOpenSettings(() => open());
    }
  } catch (_) {
    /* best effort */
  }

  return { open, close, toggle };
}
