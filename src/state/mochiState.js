/**
 * @module state/mochiState
 * Agent lifecycle states shared by the provider stream, the panel,
 * and the dog's reaction animations.
 */

export const MochiState = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WORKING: 'working',
  NEEDS_APPROVAL: 'needs-approval',
  DONE: 'done',
  ERROR: 'error',
});

/**
 * True while the agent is mid-turn (streaming, running tools, or awaiting
 * an approval decision). The panel uses this to gate new submissions.
 * @param {string} s
 * @returns {boolean}
 */
export function isAgentBusy(s) {
  return s === MochiState.THINKING || s === MochiState.WORKING || s === MochiState.NEEDS_APPROVAL;
}
