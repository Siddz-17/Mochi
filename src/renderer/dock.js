/**
 * dock.js — hide-at-the-left-edge behaviour.
 *
 *   out    : dog is on screen, wanders, click opens the chat.
 *   docked : dog is hidden at the LEFT screen edge, only a sliver peeks out.
 *
 * Flow:
 *   - 20s with no activity over the dog/panel (and chat closed) -> dog walks to
 *     the left edge and tucks in (peek animation).
 *   - FIRST click on the peeking dog -> it pops out and walks back on screen.
 *     The chat does NOT open.
 *   - Click again (now out) -> chat opens (handled by the normal click path).
 *
 * "Activity" = mouse moving over the dog / chat panel / settings, any click,
 * any key press, dragging, or the chat being open.
 */

export function createDock({ bridge = {}, dog, wander, panel, getConfig = () => ({}) } = {}) {
  let state = 'out'; // 'out' | 'docked'
  let busy = false; // a walk to/from the edge is in progress
  let dragging = false;
  let lastActivity = Date.now();
  let timer = null;

  const enabled = () => getConfig().dockEnabled !== false;
  const idleMs = () => Math.max(5, Number(getConfig().dockIdleSeconds) || 20) * 1000;
  const touch = () => { lastActivity = Date.now(); };
  const resumeWander = () => {
    if (wander && getConfig().wanderEnabled !== false) wander.resume();
  };

  // ---- activity tracking (only counts when the pointer is over Mochi's UI)
  const overMochi = (e) => {
    const t = e && e.target;
    return !!(t && t.closest && t.closest('#stage, #panel, #settings'));
  };
  window.addEventListener('mousemove', (e) => { if (overMochi(e)) touch(); }, true);
  window.addEventListener('mousedown', touch, true);
  window.addEventListener('keydown', touch, true);

  // ---- walk to the left edge and hide
  async function dock() {
    if (busy || state !== 'out' || dragging) return;
    busy = true;
    try {
      if (panel && panel.isOpen && panel.isOpen()) panel.toggle();
      if (wander) wander.pause();
      const g = await bridge.getDockGeometry();
      const pos = await bridge.getPosition();
      const dist = Math.abs((pos ? pos.x : g.outX) - g.peekX);
      dog.startWalk('left');
      const ok = await bridge.glide(g.peekX, g.y, Math.min(3500, Math.max(700, (dist / 180) * 1000)));
      if (!ok) { // interrupted (clicked / dragged / reset)
        dog.stopWalk();
        if (state === 'out') resumeWander();
        return;
      }
      state = 'docked';
      bridge.setDocked(true);
      dog.setDocked(true);
    } catch (err) {
      console.warn('[mochi] dock failed:', err);
      dog.stopWalk();
      resumeWander();
    } finally {
      busy = false;
    }
  }

  // ---- pop out (does NOT open the chat)
  async function popOut() {
    if (busy || state !== 'docked') return;
    busy = true;
    touch();
    try {
      const g = await bridge.getDockGeometry();
      state = 'out';
      bridge.setDocked(false);
      dog.setDocked(false);
      dog.startWalk('right');
      await bridge.glide(g.outX, g.y, 900);
      dog.stopWalk();
      dog.setAgentState('done'); // little hop + sparkle
      touch();
      resumeWander();
    } catch (err) {
      console.warn('[mochi] pop out failed:', err);
      dog.stopWalk();
    } finally {
      busy = false;
    }
  }

  /** Called on every clean click on the dog. Returns true if the click was used up here. */
  function handleClick() {
    touch();
    if (state === 'docked') { popOut(); return true; }
    if (busy) { bridge.cancelGlide(); return true; } // clicked while walking home: stay out
    return false;
  }

  function forceOut() {
    state = 'out';
    busy = false;
    dog.setDocked(false);
    touch();
    resumeWander();
  }

  // ---- hooks used by dog.js while dragging
  function noteDragStart() {
    dragging = true;
    touch();
    if (busy) bridge.cancelGlide();
    if (state === 'docked') {
      state = 'out';
      bridge.setDocked(false);
      dog.setDocked(false);
    }
  }
  function noteDragEnd() {
    dragging = false;
    touch();
  }

  // Opening the chat (e.g. by hotkey) while hidden brings the dog out.
  window.addEventListener('mochi:panel', (e) => {
    if (e.detail && e.detail.open && state === 'docked') forceOut();
    if (e.detail && e.detail.open) touch();
  });

  if (typeof bridge.onDockNow === 'function') bridge.onDockNow(() => dock());
  if (typeof bridge.onDockState === 'function') {
    bridge.onDockState((s) => { if (s && s.state === 'out') forceOut(); });
  }

  // ---- idle watcher
  timer = setInterval(() => {
    if (!enabled() || state !== 'out' || busy || dragging) return;
    if (panel && panel.isOpen && panel.isOpen()) { touch(); return; }
    if (Date.now() - lastActivity >= idleMs()) dock();
  }, 1000);

  return {
    handleClick,
    noteDragStart,
    noteDragEnd,
    dock,
    popOut,
    isDocked: () => state === 'docked',
    destroy() { clearInterval(timer); },
  };
}
