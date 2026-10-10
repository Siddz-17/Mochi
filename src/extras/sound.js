// src/extras/sound.js
// Tiny WebAudio-synthesized 8-bit sound effects for Mochi.
// Square-wave blips with short envelopes — no audio assets, no network.
//
// Muted by default: the master gain sits at 0 until setEnabled(true) is
// called (the renderer wires this to `soundsEnabled` in config).

/**
 * @returns {{ setEnabled: (b: boolean) => void, isEnabled: () => boolean,
 *             bark: () => void, pant: () => void, pop: () => void }}
 */
export function createSound() {
  /** @type {AudioContext | null} */
  let ctx = null;
  /** @type {GainNode | null} */
  let master = null;
  let enabled = false;

  function ensureCtx() {
    if (ctx) return true;
    const AC =
      typeof window !== 'undefined' &&
      (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0; // muted until explicitly enabled
    master.connect(ctx.destination);
    return true;
  }

  /**
   * Play one square-wave blip with a fast attack / exponential decay envelope.
   */
  function tone(freqStart, freqEnd, durMs, delayMs = 0, volume = 0.4) {
    if (!enabled || !ensureCtx()) return;
    if (ctx.state === 'suspended') {
      // Best effort: resume is async; the blip still schedules fine.
      void ctx.resume();
    }
    const t0 = ctx.currentTime + delayMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(Math.max(1, freqStart), t0);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, freqEnd),
      t0 + durMs / 1000,
    );
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.05);
  }

  return {
    /** Enable/disable all sound. Master gain is 0 while disabled. */
    setEnabled(b) {
      enabled = !!b;
      if (ensureCtx()) {
        if (ctx.state === 'suspended') void ctx.resume();
        master.gain.setTargetAtTime(enabled ? 0.18 : 0, ctx.currentTime, 0.02);
      }
    },

    isEnabled() {
      return enabled;
    },

    /** Two quick descending yips — the "alert bark". */
    bark() {
      tone(540, 320, 90, 0);
      tone(500, 300, 90, 110);
    },

    /** Three rapid soft pulses — happy panting. */
    pant() {
      tone(230, 170, 55, 0, 0.25);
      tone(230, 170, 55, 85, 0.25);
      tone(230, 170, 55, 170, 0.25);
    },

    /** Single rising blip — UI confirm / timer transitions. */
    pop() {
      tone(660, 990, 70, 0, 0.35);
    },
  };
}
