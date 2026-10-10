/**
 * @module state/mochiState
 * Agent lifecycle states shared by the provider stream, the panel,
 * and the dog's reaction animations.
 */

export const MochiState = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  DONE: 'done',
  ERROR: 'error',
});

/**
 * True while the agent is generating a response.
 * @param {string} s
 * @returns {boolean}
 */
export function isAgentBusy(s) {
  return s === MochiState.THINKING;
}
