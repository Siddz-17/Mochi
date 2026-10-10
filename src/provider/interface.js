/**
 * @module provider/interface
 *
 * JSDoc-only type definitions for Mochi's agent-provider boundary.
 * Providers are plain ES modules — no vendor SDKs, no API keys, no network.
 * The only bundled provider is the offline MockProvider (see `mock.js`).
 */

/**
 * A single chat message exchanged with a provider.
 * @typedef {Object} ChatMessage
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string} content
 */

/**
 * Tools adapter the panel hands to `AgentProvider.send()`.
 * The panel owns this: read-only tools run immediately via the bridge,
 * write/shell tools render an in-panel approval card first.
 * @typedef {Object} ProviderTools
 * @property {(name: string, args: object) => Promise<object>} invokeTool
 *   Run a named tool. Resolves to `{ok:true, ...}` or `{ok:false, ...}`.
 * @property {(info: ToolApprovalInfo) => Promise<boolean>} requestApproval
 *   Render an approval card and resolve true/false on user decision.
 */

/**
 * Info shown on an approval card (in-panel or main-initiated).
 * @typedef {Object} ToolApprovalInfo
 * @property {string} [id]        Approval request id (main-initiated flow).
 * @property {string} tool        Tool name, e.g. `files.write`.
 * @property {object} args        Tool arguments.
 * @property {string} [description] Human-readable summary of what will happen.
 * @property {string} [detail]    Verbatim detail: command or unified-ish diff.
 */

/**
 * @typedef {Object} TextDeltaEvent
 * @property {'text-delta'} type
 * @property {string} delta  3–8 character chunk of streamed assistant text.
 */

/**
 * @typedef {Object} ToolRequestEvent
 * @property {'tool-request'} type
 * @property {string} id          Unique id for this tool call.
 * @property {string} tool        Tool name, e.g. `files.list`.
 * @property {object} args        Tool arguments.
 * @property {string} [description] Human-readable summary.
 * @property {string} [detail]    Verbatim detail (command / diff).
 */

/**
 * @typedef {Object} ToolResultEvent
 * @property {'tool-result'} type
 * @property {string} id
 * @property {boolean} ok
 * @property {object} [result]  Present when ok.
 * @property {string} [error]   Present when !ok.
 */

/**
 * @typedef {Object} StateEvent
 * @property {'state'} type
 * @property {'idle'|'thinking'|'working'|'needs-approval'|'done'|'error'} state
 */

/**
 * @typedef {Object} DoneEvent
 * @property {'done'} type
 */

/**
 * @typedef {Object} ErrorEvent
 * @property {'error'} type
 * @property {string} message
 */

/**
 * Every event a provider may yield from `send()`.
 * @typedef {TextDeltaEvent|ToolRequestEvent|ToolResultEvent|StateEvent|DoneEvent|ErrorEvent} AgentEvent
 */

/**
 * Minimal provider contract. `send` is an async generator so the panel can
 * render the conversation event-by-event (streaming text, tool calls, states).
 * @typedef {Object} AgentProvider
 * @property {string} id   Stable id, e.g. `mock`.
 * @property {string} name Display name, e.g. `Mock (offline demo)`.
 * @property {(messages: ChatMessage[], tools: ProviderTools, signal?: AbortSignal) => AsyncGenerator<AgentEvent, void, void>} send
 */

export const AGENT_EVENT_TYPES = Object.freeze([
  'text-delta',
  'tool-request',
  'tool-result',
  'state',
  'done',
  'error',
]);

const AGENT_STATES = new Set(['idle', 'thinking', 'working', 'needs-approval', 'done', 'error']);

/**
 * Validate a provider-emitted event's shape.
 * @param {any} e
 * @returns {{ok: boolean, error?: string}}
 */
export function validateEvent(e) {
  if (!e || typeof e !== 'object') return { ok: false, error: 'event must be an object' };
  switch (e.type) {
    case 'text-delta':
      return typeof e.delta === 'string'
        ? { ok: true }
        : { ok: false, error: 'text-delta.delta must be a string' };
    case 'tool-request':
      return typeof e.id === 'string' && typeof e.tool === 'string' && e.args && typeof e.args === 'object'
        ? { ok: true }
        : { ok: false, error: 'tool-request needs string id, string tool, object args' };
    case 'tool-result':
      return typeof e.id === 'string' && typeof e.ok === 'boolean'
        ? { ok: true }
        : { ok: false, error: 'tool-result needs string id and boolean ok' };
    case 'state':
      return AGENT_STATES.has(e.state)
        ? { ok: true }
        : { ok: false, error: `state must be one of ${[...AGENT_STATES].join(', ')}` };
    case 'done':
      return { ok: true };
    case 'error':
      return typeof e.message === 'string'
        ? { ok: true }
        : { ok: false, error: 'error.message must be a string' };
    default:
      return { ok: false, error: `unknown event type: ${String(e && e.type)}` };
  }
}
