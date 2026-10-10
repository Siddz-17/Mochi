/**
 * wander.js — Mochi screen wander controller.
 *
 * Moves the Electron window smoothly across the screen at ~60fps.
 * The dog stays in place for 20-90s, then walks to a new spot, sits,
 * looks around, and repeats. Mostly along the bottom (just above
 * the taskbar), occasionally to other spots.
 *
 * Pauses when: chat panel is open, dog is being dragged, dog is asleep,
 * or wanderEnabled is false.
 *
 * PUBLIC API:
 *   import { createWander } from './wander.js';
 *   const wander = createWander({ bridge, dog, getConfig });
 *   wander.start();
 *   wander.stop();
 *   wander.pause();
 *   wander.resume();
 *   wander.destroy();
 */

export function createWander(opts = {}) {
  const { bridge = {}, dog = {}, getConfig = () => ({}) } = opts;

  let active = false;
  let paused = false;
  let destroyed = false;
  let moving = false;
  let idleTimer = null;
  let moveRaf = null;

  // Current and target positions
  let currentX = 0;
  let currentY = 0;
  let targetX = 0;
  let targetY = 0;
  let moveStartX = 0;
  let moveStartY = 0;
  let moveStartTime = 0;
  let moveDuration = 0;

  // --- helpers ---
  // Safe window x/y range computed by the main process: the dog is always
  // fully on the home screen (above the taskbar). Single display only.
  async function getBounds() {
    try {
      if (typeof bridge.getWanderBounds === 'function') {
        const b = await bridge.getWanderBounds();
        if (b && [b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite)) return b;
      }
    } catch {}
    return null;
  }

  async function getCurrentPos() {
    try {
      const p = await bridge.getPosition();
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    } catch {}
    return { x: currentX, y: currentY };
  }

  function pickTarget(b) {
    const spanX = Math.max(0, b.maxX - b.minX);
    const x = b.minX + Math.random() * spanX;
    // 70%: along the bottom (just above the taskbar). 30%: somewhere else,
    // but only in the lower 60% of the screen so it never goes to the very top.
    if (Math.random() < 0.7) return { x, y: b.maxY };
    const spanY = Math.max(0, b.maxY - b.minY);
    return { x, y: b.minY + spanY * (0.4 + Math.random() * 0.6) };
  }

  // Ease in-out cubic
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function scheduleIdle() {
    if (destroyed || !active || paused) return;
    clearTimeout(idleTimer);
    // Short gaps: the dog hides at the left edge after ~20s of no interaction,
    // so it gets one or two little walks in before that.
    const lo = 6000, hi = 15000;
    const delay = lo + Math.random() * (hi - lo);
    idleTimer = setTimeout(() => {
      if (!destroyed && active && !paused) startMove();
    }, delay);
  }

  async function startMove() {
    if (destroyed || !active || paused || moving) return;

    const pos = await getCurrentPos();
    currentX = pos.x;
    currentY = pos.y;

    const bounds = await getBounds();
    if (!bounds) {
      scheduleIdle();
      return;
    }
    const target = pickTarget(bounds);

    // Don't move if very close to target
    const dist = Math.hypot(target.x - currentX, target.y - currentY);
    if (dist < 50) {
      scheduleIdle();
      return;
    }

    targetX = target.x;
    targetY = target.y;
    moveStartX = currentX;
    moveStartY = currentY;
    moveStartTime = performance.now();
    // Speed: ~100px/s, min 1.5s, max 6s
    moveDuration = Math.max(1500, Math.min(6000, dist / 100 * 1000));
    moving = true;

    // Tell the dog to walk
    const direction = targetX < currentX ? 'left' : 'right';
    if (dog && typeof dog.startWalk === 'function') {
      dog.startWalk(direction);
    }

    animateMove();
  }

  function animateMove() {
    if (destroyed || !moving || paused) {
      finishMove();
      return;
    }

    const now = performance.now();
    const elapsed = now - moveStartTime;
    const progress = Math.min(1, elapsed / moveDuration);
    const eased = easeInOutCubic(progress);

    const x = moveStartX + (targetX - moveStartX) * eased;
    const y = moveStartY + (targetY - moveStartY) * eased;
    currentX = x;
    currentY = y;

    try {
      bridge.savePosition(Math.round(x), Math.round(y));
    } catch {}

    if (progress < 1) {
      moveRaf = requestAnimationFrame(animateMove);
    } else {
      finishMove();
    }
  }

  function finishMove() {
    moving = false;
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
    if (dog && typeof dog.stopWalk === 'function') {
      dog.stopWalk();
    }
    if (!destroyed && active && !paused) {
      scheduleIdle();
    }
  }

  // --- public API ---
  function start() {
    if (destroyed) return;
    active = true;
    paused = false;
    scheduleIdle();
  }

  function stop() {
    active = false;
    clearTimeout(idleTimer);
    idleTimer = null;
    if (moving) finishMove();
  }

  function pause() {
    paused = true;
    if (moving) {
      // Stop moving immediately
      if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = null; }
      moving = false;
      if (dog && typeof dog.stopWalk === 'function') dog.stopWalk();
    }
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function resume() {
    if (!active || destroyed) return;
    paused = false;
    if (!moving) scheduleIdle();
  }

  function destroy_() {
    destroyed = true;
    stop();
  }

  return { start, stop, pause, resume, isMoving: () => moving, destroy: destroy_ };
}
