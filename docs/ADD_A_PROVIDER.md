# Adding an AI Provider to Mochi

> 🔌 **Status: CONNECTED (draft).** Mochi ships with the local `mock`
> provider and a `groq` provider for the Groq API. To go live with Groq,
> export `GROQ_API_KEY` (free at https://console.groq.com) and set
> `"provider": "groq"` in `mochi.config.json`. The steps below also cover
> how a further provider gets plugged in.

## The contract

Every provider implements the `AgentProvider` interface defined in
`src/provider/interface.js` — JSDoc typedefs, no build step. `send` is an
async generator so the panel can render the conversation event-by-event.
(Bundled providers: the offline `MockProvider` in `src/provider/mock.js` —
read it as the reference implementation — and `GroqProvider` in
`src/provider/groq.js`.)

```js
// src/provider/interface.js (typedefs, pasted verbatim)

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
```

The file also exports `validateEvent(e)` — use it in tests to check the
events your provider yields.

## Steps

### 1. Implement `src/provider/<id>.js`

Create the file and export a class implementing `AgentProvider`.
`send` is an `async *` generator that yields `AgentEvent`s. Load your API
key in the constructor (see "API keys" — never committed):

```js
// src/provider/openai.js  (example)
export class OpenAIProvider {
  constructor() {
    this.apiKey = loadKeySomehow(); // env var or OS keychain
    if (!this.apiKey) throw new Error('MOCHI_OPENAI_API_KEY is not set');
  }

  get id() { return 'openai'; }
  get name() { return 'OpenAI'; }

  async *send(messages, tools, signal) {
    yield { type: 'state', state: 'thinking' };
    // ... call the vendor API, streaming ...
    yield { type: 'state', state: 'working' };
    yield { type: 'text-delta', delta: 'Hello' };
    // ... more deltas ...
    yield { type: 'done' };
  }
}
```

Rules:
- Yield `state` events (`thinking` → `working` → …) so the dog reacts
  (thinking / working / alert-bark / hop / sad).
- Stream assistant text as small `text-delta` chunks; finish with `done`.
- Tool calls: yield a `tool-request` event for display, then run it via
  the `tools` adapter. Read-only tools go straight through
  `tools.invokeTool(name, args)`; anything that writes or shells out
  **must** first `await tools.requestApproval({ tool, args, description })`
  — that renders the in-panel approval card (default deny).
  Then yield the matching `tool-result`.
- Honor the `AbortSignal`: stop yielding when `signal.aborted`.
- On failure yield `{ type: 'error', message }` — never throw out of `send`.

### 2. Register it in `src/provider/registry.js`

```js
import { OpenAIProvider } from './openai.js';

providers.openai = () => new OpenAIProvider();
```

### 3. Point the config at it

In `mochi.config.json`:

```json
{ "provider": "openai" }
```

The registry loads the provider named by `provider` at startup (an unknown
id throws with a pointer back to this doc).

### 4. API keys — never committed

- Preferred: read from an env var, e.g. `MOCHI_OPENAI_API_KEY`.
- Alternative: store in the OS keychain via
  [`keytar`](https://github.com/atom/node-keytar)
  (`keytar.getPassword('mochi', 'openai')`), so the secret lives in
  Keychain / Credential Manager / libsecret instead of on disk.
- **NEVER** put a key in `mochi.config.json`, in source, or in git.
  `mochi.config.json` is user-local config; secrets don't belong there.

## That's it

No other code changes are needed: the panel, dog reactions, tool sandbox,
and approval cards all talk to the `AgentProvider` interface, not to any
specific provider. To switch back, set `"provider": "mock"` again.
