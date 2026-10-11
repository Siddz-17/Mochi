/**
 * @module renderer/panel
 *
 * Chat panel for Mochi: streaming message list, approval cards, and status
 * line. Opens only on explicit toggle (dog click / hotkey / tray) and pops
 * out directly under the dog like a speech bubble (see positionPanel).
 * Owns the `tools` adapter handed to the provider's `send()`:
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
import { renderMarkdown, attachCopyButtons } from './markdown.js';
import { createToolResultElement, getToolExport } from './toolResults.js';

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
  // #panel-badge is a sibling of #panel (not a child), so it must be looked
  // up on the document, not inside rootEl.
  const badge = document.getElementById('panel-badge');
  const stopBtn = rootEl.querySelector('#chat-stop');
  const regenBtn = rootEl.querySelector('#chat-regen');
  const exportBtn = rootEl.querySelector('#chat-export');

  let isOpen = false;
  let busy = false;
  let controller = null;
  let provider = null;
  let providerError = null;
  let cfg = {};
  let history = loadHistory();
  let lastUserText = '';
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

  history.forEach((m) =>
    appendMessage(m.role, m.content, { save: false, markdown: m.role === 'assistant' })
  );
  updateStatusLine();
  setAgentState(MochiState.IDLE);

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (controller) {
        try {
          controller.abort();
        } catch {
          /* noop */
        }
      }
    });
  }
  if (regenBtn) regenBtn.addEventListener('click', regenerate);
  if (exportBtn) exportBtn.addEventListener('click', exportConversation);

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

  /**
   * Anchor the panel directly under the dog sprite so the chat pops out
   * like a speech bubble next to the dog at any sprite scale, and shrink
   * its max-height so it always fits inside the window. Called on every
   * open() because the dog may have been dragged since the last open.
   */
  function positionPanel() {
    let s = 4;
    try {
      const c = typeof getConfig === 'function' ? getConfig() : {};
      const n = Math.round(Number(c && c.scale));
      if (Number.isFinite(n)) s = Math.min(6, Math.max(2, n));
    } catch {
      /* keep default */
    }
    const dogPx = 32 * s;
    rootEl.style.left = '0px';
    rootEl.style.top = `${dogPx + 10}px`;
    rootEl.style.maxHeight = `${Math.max(160, 480 - dogPx - 26)}px`;
    if (badge) {
      badge.style.left = `${dogPx - 14}px`;
      badge.style.top = '6px';
      badge.style.bottom = 'auto';
    }
  }

  function open() {
    positionPanel();
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
      appendMessage('assistant', 'No provider loaded. Check your mochi.config.json.', {
        markdown: true,
      });
      return;
    }
    lastUserText = text;
    setBusyUI(true);
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
      // The stream body stayed plain text while streaming (partial markdown
      // would flicker and break mid-fence); render the finished reply now.
      renderAssistantMarkdown(streamBody, assistantText);
      setBusyUI(false);
      controller = null;
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
    if (opts && opts.markdown && role === 'assistant') {
      renderAssistantMarkdown(body, text);
    } else {
      body.style.whiteSpace = 'pre-wrap';
      body.style.wordBreak = 'break-word';
      body.textContent = esc(text);
    }
    wrap.appendChild(body);
    if (messagesEl) messagesEl.appendChild(wrap);
    scrollBottom();
    if (save && !(opts && opts.stream)) pushHistory(role, text);
    return body;
  }

  /**
   * Swap a message body to its finished markdown rendering and wire the
   * copy buttons on any code blocks it contains.
   */
  function renderAssistantMarkdown(body, text) {
    body.classList.add('mochi-md');
    body.style.whiteSpace = 'normal';
    body.style.wordBreak = 'normal';
    body.innerHTML = renderMarkdown(text);
    attachCopyButtons(body);
  }

  /**
   * Regenerate: drop the latest assistant turn (bubble + history) and
   * re-send the last user message, so the fresh reply replaces the old one
   * instead of stacking a second answer.
   */
  function regenerate() {
    if (busy) {
      setStatus('Mochi is still working — one thing at a time!');
      return;
    }
    if (!lastUserText) {
      setStatus('Nothing to regenerate yet — say something first.');
      return;
    }
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();
    saveHistory();
    if (messagesEl) {
      const bubbles = messagesEl.querySelectorAll('.mochi-msg-assistant');
      const last = bubbles[bubbles.length - 1];
      if (last) last.remove();
    }
    send(lastUserText);
  }

  /** Download the visible conversation as a Markdown file. */
  function exportConversation() {
    const stamp = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const fname =
      `mochi-chat-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.md`;
    const pid = provider ? provider.id : cfg.provider || 'mock';
    const lines = [
      '# Mochi chat export',
      '',
      `_Exported ${stamp.toLocaleString()} · provider: ${pid}_`,
      '',
    ];
    for (const m of history) {
      lines.push(m.role === 'user' ? '## You' : '## Mochi', '', String(m.content), '');
    }
    // Tool outputs rendered this session (full text, kept in memory by
    // toolResults.js — truncation never destroys it).
    const toolOutputs = getToolExport();
    if (toolOutputs.length) {
      lines.push('## Tool outputs', '');
      for (const t of toolOutputs) {
        lines.push(`### ${t.ok ? '✓' : '✗'} ${t.id}`, '', '```text', String(t.text), '```', '');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
    setStatus(`Exported ${history.length} messages → ${fname}`);
    setTimeout(() => updateStatusLine(), 3000);
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
    // Rich rendering (src/renderer/toolResults.js): collapsible diffs with
    // per-file sections, truncation with show more/less, copy button. The
    // full output stays in memory for copy/export; only the visible slice
    // is truncated.
    const el = document.createElement('div');
    el.className = 'mochi-msg mochi-tool-result';
    try {
      el.appendChild(createToolResultElement(ev || {}));
    } catch {
      el.textContent = (ev && ev.ok ? `✓ ${ev.id || 'tool'} ok` : `✗ ${(ev && ev.id) || 'tool'} failed${ev && ev.error ? `: ${ev.error}` : ''}`);
      el.style.fontSize = '11px';
      el.style.opacity = '0.85';
    }
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

  function setBusyUI(on) {
    busy = on;
    if (input) input.disabled = on;
    const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
    if (sendBtn) sendBtn.disabled = on;
    if (stopBtn) stopBtn.disabled = !on;
  }

  function scrollBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
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
    saveHistory();
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* storage full / unavailable — chat still works */
    }
  }

  return { open, close, toggle, isOpen: () => isOpen, pushApprovalRequest };
}
