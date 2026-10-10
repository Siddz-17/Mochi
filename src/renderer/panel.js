/**
 * @module renderer/panel
 *
 * Chat panel for Mochi: streaming message list, quick actions, history,
 * approval cards, and status line. Owns the `tools` adapter handed to the
 * provider's `send()`:
 *   - invokeTool(name, args) → bridge.invokeTool (main runs tools.cjs).
 *     Read-only tools run immediately; write/shell tools are challenged by
 *     main via `mochi:tool-approval`, which arrives here through
 *     bridge.onToolApprovalRequest. To avoid double-prompting when the
 *     panel already approved in-panel (mock demo flow), a recent in-panel
 *     approval for the same tool+args auto-answers the main challenge.
 *   - requestApproval(info) → renders a card into #approval-area.
 */

import { MochiState, isAgentBusy } from '../state/mochiState.js';
import { renderApprovalCard } from '../tools/approval.js';

// Mirrors electron/tools.cjs READ_ONLY. Kept local: the renderer cannot
// require() the main-side CJS module (context isolation).
const READ_ONLY_TOOLS = new Set([
  'files.list',
  'files.read',
  'files.search',
  'git.status',
  'git.diff',
  'git.log',
]);

const HISTORY_KEY = 'mochi.chat.history';
const HISTORY_CAP = 100;
const PROVIDER_HISTORY = 20;
const PRE_APPROVAL_TTL_MS = 120000;

const QUICK_ACTIONS = [
  'Explain this repo',
  'What changed recently?',
  'Find a bug',
  'Write tests for…',
  'Review my diff',
];

function approvalKey(tool, args) {
  return `${tool}:${JSON.stringify(args || {})}`;
}

function esc(s) {
  return String(s);
}

/**
 * @param {HTMLElement} rootEl  The #panel element.
 * @param {{registry: {loadProvider: (id: string) => any}, bridge: any, dog?: {setAgentState?: (s: string) => void}, getConfig: () => any}} deps
 */
export function createPanel(rootEl, deps) {
  const { registry, bridge, dog, getConfig } = deps;

  const messagesEl = rootEl.querySelector('#messages');
  const form = rootEl.querySelector('#chat-form');
  const input = rootEl.querySelector('#chat-input');
  const approvalArea = rootEl.querySelector('#approval-area');
  const statusLine = rootEl.querySelector('#status-line');
  const quickRow = rootEl.querySelector('#quick-actions');
  const badge = rootEl.querySelector('#panel-badge');

  let isOpen = false;
  let busy = false;
  let controller = null;
  let provider = null;
  let providerError = null;
  let cfg = {};
  let history = loadHistory();
  const preApproved = new Map(); // approvalKey -> timestamp

  /* ---------- setup ---------- */

  function ensureProvider() {
    if (provider || providerError) return provider;
    try {
      provider = registry.loadProvider(cfg.provider || 'mock');
    } catch (err) {
      providerError = err;
      setStatus(`provider error: ${err && err.message ? err.message : err}`);
    }
    updateStatusLine();
    return provider;
  }

  // getConfig may be sync or async (preload's is an ipc invoke → Promise).
  Promise.resolve(typeof getConfig === 'function' ? getConfig() : {})
    .then((c) => {
      cfg = c || {};
      ensureProvider();
      updateStatusLine();
    })
    .catch((err) => {
      providerError = err;
      setStatus(`provider error: ${err && err.message ? err.message : err}`);
    });

  buildQuickActions();
  history.forEach((m) => appendMessage(m.role, m.content, { save: false }));
  updateStatusLine();
  setAgentState(MochiState.IDLE);

  if (bridge && typeof bridge.onTogglePanel === 'function') {
    bridge.onTogglePanel(() => toggle());
  }
  if (bridge && typeof bridge.onToolApprovalRequest === 'function') {
    bridge.onToolApprovalRequest(handleMainApprovalRequest);
  }
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(input ? input.value : '');
      if (input) input.value = '';
    });
  }
  rootEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  /* ---------- public API ---------- */

  function open() {
    isOpen = true;
    rootEl.hidden = false;
    rootEl.classList.add('open');
    if (bridge && typeof bridge.focusWindow === 'function') bridge.focusWindow();
    if (input) input.focus();
  }

  function close() {
    isOpen = false;
    rootEl.classList.remove('open');
    rootEl.hidden = true;
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* noop */
      }
    }
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  /**
   * Render an approval card for a main-initiated request and wire the
   * decision back through bridge.respondApproval.
   */
  function pushApprovalRequest(req) {
    renderApprovalCard(approvalArea, req, (approved) => {
      if (bridge && typeof bridge.respondApproval === 'function') {
        bridge.respondApproval(req && req.id, !!approved);
      }
    });
  }

  /* ---------- chat ---------- */

  async function send(text) {
    text = (text || '').trim();
    if (!text) return;
    if (busy) {
      setStatus('Mochi is still working — one thing at a time!');
      return;
    }
    const activeProvider = ensureProvider();
    if (!activeProvider) {
      appendMessage('assistant', 'No provider loaded. Check your mochi.config.json.');
      return;
    }
    busy = true;
    setInputEnabled(false);
    appendMessage('user', text, { save: false });
    pushHistory('user', text);
    const streamBody = appendMessage('assistant', '', { stream: true });
    let assistantText = '';

    controller = new AbortController();
    const tools = makeToolsAdapter();
    setAgentState(MochiState.THINKING);

    try {
      const convo = history.slice(-PROVIDER_HISTORY).map((m) => ({ role: m.role, content: m.content }));
      for await (const ev of activeProvider.send(convo, tools, controller.signal)) {
        if (!ev || typeof ev !== 'object') continue;
        switch (ev.type) {
          case 'text-delta':
            assistantText += esc(ev.delta || '');
            streamBody.textContent = assistantText;
            scrollBottom();
            break;
          case 'state':
            setAgentState(ev.state);
            break;
          case 'tool-request':
            appendToolNotice(ev);
            break;
          case 'tool-result':
            appendToolResult(ev);
            break;
          case 'error':
            assistantText += `\n⚠ ${ev.message || 'provider error'}`;
            streamBody.textContent = assistantText;
            setAgentState(MochiState.ERROR);
            break;
          case 'done':
            break;
          default:
            break;
        }
      }
      pushHistory('assistant', assistantText || '(no reply)');
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? '(stopped)' : `⚠ ${err && err.message ? err.message : err}`;
      assistantText += `\n${msg}`;
      streamBody.textContent = assistantText;
      pushHistory('assistant', assistantText);
      setAgentState(MochiState.ERROR);
    } finally {
      busy = false;
      controller = null;
      setInputEnabled(true);
      updateStatusLine();
      scrollBottom();
    }
  }

  function makeToolsAdapter() {
    return {
      invokeTool: (name, args) => bridge.invokeTool(name, args || {}),
      requestApproval: (info) =>
        new Promise((resolve) => {
          renderApprovalCard(approvalArea, info, (approved) => {
            if (approved) preApproved.set(approvalKey(info.tool, info.args), Date.now());
            resolve(approved);
          });
        }),
    };
  }

  /** Main challenged us for a write/shell tool invoked through the bridge. */
  function handleMainApprovalRequest(req) {
    if (!req) return;
    const key = approvalKey(req.tool, req.args);
    const ts = preApproved.get(key);
    if (ts && Date.now() - ts < PRE_APPROVAL_TTL_MS) {
      // The user already approved this exact call in-panel (e.g. mock demo
      // flow): answer the main challenge without prompting twice.
      preApproved.delete(key);
      if (bridge && typeof bridge.respondApproval === 'function') {
        bridge.respondApproval(req.id, true);
      }
      return;
    }
    pushApprovalRequest(req);
  }

  /* ---------- rendering helpers ---------- */

  function appendMessage(role, text, opts) {
    const save = !opts || opts.save !== false;
    const wrap = document.createElement('div');
    wrap.className = `mochi-msg mochi-msg-${role}`;
    const body = document.createElement('div');
    body.className = 'mochi-msg-body';
    body.style.whiteSpace = 'pre-wrap';
    body.style.wordBreak = 'break-word';
    body.textContent = esc(text);
    wrap.appendChild(body);
    if (messagesEl) messagesEl.appendChild(wrap);
    scrollBottom();
    if (save && !(opts && opts.stream)) pushHistory(role, text);
    return body;
  }

  function appendToolNotice(ev) {
    const auto = READ_ONLY_TOOLS.has(ev.tool);
    const line = auto
      ? `⚙ ${ev.tool} — read-only, running…`
      : `⚙ ${ev.tool} — needs your approval…`;
    const el = document.createElement('div');
    el.className = 'mochi-msg mochi-tool-notice';
    el.textContent = line;
    el.style.fontSize = '11px';
    el.style.opacity = '0.85';
    if (messagesEl) messagesEl.appendChild(el);
    scrollBottom();
  }

  function appendToolResult(ev) {
    const el = document.createElement('div');
    el.className = 'mochi-msg mochi-tool-result';
    el.textContent = ev.ok ? `✓ ${ev.id || 'tool'} ok` : `✗ ${ev.id || 'tool'} failed${ev.error ? `: ${ev.error}` : ''}`;
    el.style.fontSize = '11px';
    el.style.opacity = '0.85';
    if (messagesEl) messagesEl.appendChild(el);
    scrollBottom();
  }

  function setAgentState(state) {
    try {
      if (dog && typeof dog.setAgentState === 'function') dog.setAgentState(state);
    } catch {
      /* dog animations are best-effort */
    }
    if (badge) {
      const label =
        state === MochiState.THINKING
          ? '💭 thinking'
          : state === MochiState.WORKING
            ? '⚙ working'
            : state === MochiState.NEEDS_APPROVAL
              ? '⚠ needs approval'
              : state === MochiState.DONE
                ? '✓ done'
                : state === MochiState.ERROR
                  ? '✗ error'
                  : '🐶 idle';
      badge.textContent = label;
    }
    updateStatusLine(state);
  }

  function setStatus(text) {
    if (statusLine) statusLine.textContent = text;
  }

  function updateStatusLine(state) {
    const pid = provider ? provider.id : cfg.provider || 'mock';
    const folder = cfg.root || cfg.workingFolder || 'repo';
    const busyNote = state && isAgentBusy(state) ? ` · ${state}…` : '';
    setStatus(`provider: ${pid} (not connected) · folder: ${folder}${busyNote}`);
  }

  function setInputEnabled(enabled) {
    if (input) input.disabled = !enabled;
    const btn = form ? form.querySelector('button[type="submit"]') : null;
    if (btn) btn.disabled = !enabled;
  }

  function scrollBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildQuickActions() {
    if (!quickRow) return;
    quickRow.innerHTML = '';
    for (const label of QUICK_ACTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mochi-quick-action';
      btn.textContent = label;
      btn.addEventListener('click', () => send(label));
      quickRow.appendChild(btn);
    }
  }

  /* ---------- history ---------- */

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.filter((m) => m && typeof m.content === 'string').slice(-HISTORY_CAP)
        : [];
    } catch {
      return [];
    }
  }

  function pushHistory(role, content) {
    history.push({ role, content: String(content) });
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* storage full / unavailable — chat still works */
    }
  }

  return { open, close, toggle, isOpen: () => isOpen, pushApprovalRequest };
}
