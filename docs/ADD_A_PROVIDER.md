# Adding an AI Provider to Mochi

> 🔌 **Status: NOT CONNECTED YET.** Mochi currently runs on the local
> `mock` provider only. The steps below describe exactly how a real
> provider gets plugged in later. No external AI provider code ships with this build.

## The Contract

Every provider implements the `AgentProvider` interface defined in
`src/provider/interface.js` — plain ES modules, no build step. `send` is an
async generator so the chat panel can render the conversation event-by-event.
(The only bundled provider is the offline `MockProvider` in
`src/provider/mock.js` — read it as the reference implementation.)

```js
/**
 * Minimal provider contract.
 * @typedef {Object} AgentProvider
 * @property {string} id   Stable id, e.g. `mock`.
 * @property {string} name Display name, e.g. `Mock (offline demo)`.
 * @property {(messages: ChatMessage[], tools: object, signal?: AbortSignal, meta?: object) => AsyncGenerator<AgentEvent, void, void>} send
 */
```

## Steps to add a provider

### 1. Implement `src/provider/<id>.js`

Create the file and export a class implementing `AgentProvider`.
`send` is an `async *` generator that yields `AgentEvent`s:

```js
// src/provider/anthropic.js (example)
export class AnthropicProvider {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  }

  get id() { return 'anthropic'; }
  get name() { return 'Anthropic Claude'; }

  async *send(messages, tools, signal, meta = {}) {
    yield { type: 'state', state: 'thinking' };
    
    // Call the streaming API endpoint...
    // yield { type: 'text-delta', delta: 'chunk' };
    
    yield { type: 'state', state: 'done' };
    yield { type: 'done' };
  }
}
```

Rules:
- Yield `state` events (`thinking` → `done` or `error`) so the dog animates appropriately.
- Stream assistant text as `text-delta` chunks; finish with `done`.
- Honor the `AbortSignal`: stop yielding when `signal.aborted`.
- On failure yield `{ type: 'error', message }` — never throw out of `send`.

### 2. Register it in `src/provider/registry.js`

```js
import { AnthropicProvider } from './anthropic.js';

providers.anthropic = () => new AnthropicProvider();
```

### 3. Point the config at it

In `mochi.config.json`:

```json
{ "provider": "anthropic" }
```

### 4. API keys — never committed

- Preferred: read from an environment variable (e.g., `ANTHROPIC_API_KEY`).
- **NEVER** put an API key in `mochi.config.json` or source code.
