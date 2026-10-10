/**
 * @module renderer/panel
 *
 * Chat panel for Mochi: speech-bubble style, streaming message list,
 * chat history in localStorage, and dog companion responses.
 */

import { MochiState, isAgentBusy } from '../state/mochiState.js';

const HISTORY_KEY = 'mochi.chat.history';
const HISTORY_CAP = 60;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

export function createPanel(rootEl, deps = {}) {
  const { registry, bridge = {}, dog, getConfig = () => ({}) } = deps;

  const messagesEl = rootEl.querySelector('#messages');
  const form = rootEl.querySelector('#chat-form');
  const input = rootEl.querySelector('#chat-input');
  const statusLine = rootEl.querySelector('#status-line');
  const clearBtn = rootEl.querySelector('#chat-clear');
  const closeBtn = rootEl.querySelector('#chat-close');

  let isOpen = false;
  let busy = false;
  let controller = null;
  let provider = null;
  let history = loadHistory();

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.slice(-HISTORY_CAP);
      }
    } catch {}
    return [];
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_CAP)));
    } catch {}
  }

  function ensureProvider() {
    if (provider) return provider;
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    try {
      provider = registry.loadProvider(cfg.provider || 'mock');
    } catch (err) {
      console.warn('[mochi] failed to load provider:', err);
    }
    return provider;
  }

  function appendMessage(role, content) {
    const el = document.createElement('div');
    el.className = `mochi-msg mochi-msg-${role}`;
    el.innerHTML = esc(content).replace(/\n/g, '<br>');
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function renderHistory() {
    messagesEl.innerHTML = '';
    if (history.length === 0) {
      const cfg = typeof getConfig === 'function' ? getConfig() : {};
      const greeting = cfg.userName
        ? `Woof, ${cfg.userName}! I'm Mochi. Click me or type below to chat!`
        : "Woof! I'm Mochi, your desktop dog companion! What's on your mind?";
      appendMessage('assistant', greeting);
    } else {
      for (const msg of history) {
        appendMessage(msg.role, msg.content);
      }
    }
  }

  function setStatus(text) {
    if (statusLine) {
      statusLine.textContent = text || '';
    }
  }

  async function submitMessage(text) {
    if (!text || busy) return;
    const cleanText = text.trim();
    if (!cleanText) return;

    input.value = '';
    busy = true;
    form.querySelector('button[type="submit"]')?.setAttribute('disabled', 'true');

    history.push({ role: 'user', content: cleanText });
    saveHistory();
    appendMessage('user', cleanText);

    if (dog && typeof dog.setAgentState === 'function') {
      dog.setAgentState(MochiState.THINKING);
    }
    setStatus('Mochi is thinking…');

    const assistantMsgEl = appendMessage('assistant', '');
    let assistantText = '';

    controller = new AbortController();
    const activeProvider = ensureProvider();
    const cfg = typeof getConfig === 'function' ? getConfig() : {};

    try {
      if (!activeProvider) {
        throw new Error('No provider available.');
      }

      for await (const event of activeProvider.send(
        history,
        {},
        controller.signal,
        { userName: cfg.userName }
      )) {
        if (!event) continue;

        if (event.type === 'text-delta' && event.delta) {
          assistantText += event.delta;
          assistantMsgEl.innerHTML = esc(assistantText).replace(/\n/g, '<br>');
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (event.type === 'state') {
          if (dog && typeof dog.setAgentState === 'function') {
            dog.setAgentState(event.state);
          }
        } else if (event.type === 'error') {
          assistantText += `\n[Error: ${event.message || 'Something went wrong.'}]`;
          assistantMsgEl.innerHTML = esc(assistantText).replace(/\n/g, '<br>');
          if (dog && typeof dog.setAgentState === 'function') {
            dog.setAgentState(MochiState.ERROR);
          }
        }
      }

      if (assistantText.trim()) {
        history.push({ role: 'assistant', content: assistantText.trim() });
        saveHistory();
      }

      if (dog && typeof dog.setAgentState === 'function') {
        dog.setAgentState(MochiState.DONE);
      }
      setStatus('');
    } catch (err) {
      if (!controller.signal.aborted) {
        assistantMsgEl.innerHTML = esc(`Woof... error: ${err.message || err}`);
        if (dog && typeof dog.setAgentState === 'function') {
          dog.setAgentState(MochiState.ERROR);
        }
        setStatus('Error occurred');
      }
    } finally {
      busy = false;
      controller = null;
      form.querySelector('button[type="submit"]')?.removeAttribute('disabled');
      input.focus();
    }
  }

  function notifyOpen(v) {
    try { if (typeof bridge.setPanelOpen === 'function') bridge.setPanelOpen(v); } catch {}
    try { window.dispatchEvent(new CustomEvent('mochi:panel', { detail: { open: v } })); } catch {}
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    notifyOpen(true);
    rootEl.classList.remove('hidden');
    rootEl.removeAttribute('hidden');
    renderHistory();
    if (typeof bridge.focusWindow === 'function') {
      try { bridge.focusWindow(); } catch {}
    }
    if (typeof bridge.setIgnoreMouseEvents === 'function') {
      try { bridge.setIgnoreMouseEvents(false); } catch {}
    }
    if (dog && typeof dog.setPanelOpen === 'function') {
      dog.setPanelOpen(true);
    }
    setTimeout(() => input?.focus(), 50);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    notifyOpen(false);
    rootEl.classList.add('hidden');
    rootEl.setAttribute('hidden', '');
    if (controller) {
      controller.abort();
      controller = null;
    }
    busy = false;
    setStatus('');
    if (dog && typeof dog.setPanelOpen === 'function') {
      dog.setPanelOpen(false);
    }
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // Event listeners
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitMessage(input.value);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      history = [];
      try { localStorage.removeItem(HISTORY_KEY); } catch {}
      renderHistory();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      close();
    });
  }

  // Intercept bridge toggle-panel signal
  if (typeof bridge.onTogglePanel === 'function') {
    bridge.onTogglePanel(() => toggle());
  }

  return {
    open,
    close,
    toggle,
    isOpen: () => isOpen,
    destroy() {
      close();
      if (controller) controller.abort();
    },
  };
}
