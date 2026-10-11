/**
 * @module provider/groq
 *
 * GroqProvider — Mochi's real-AI slot for the Groq API
 * (https://api.groq.com/openai/v1, OpenAI-compatible `/chat/completions`).
 *
 * REGISTERED in `src/provider/registry.js` as provider id `"groq"`;
 * select it with `"provider": "groq"` in `mochi.config.json`. Without
 * `GROQ_API_KEY` in the environment the constructor throws a setup
 * message that the panel surfaces as a status line (no crash).
 *
 * Setup (do NOT commit secrets):
 *   - Get a free API key at https://console.groq.com (sign up, "API Keys").
 *   - Export it in the shell you launch Mochi from:
 *         export GROQ_API_KEY="your-key-here"
 *     (MOCHI_GROQ_API_KEY also works; GROQ_API_KEY wins if both are set.
 *      Or store it in the OS keychain and read it here via keytar.)
 *   - Optionally override the model: MOCHI_GROQ_MODEL
 *     (default llama-3.3-70b-versatile).
 *
 * Conventions honored:
 *   - No vendor SDKs — plain `fetch` + SSE parsing only.
 *   - Yields `state` events (thinking → working → …) so the dog reacts.
 *   - Read-only tools run straight through `tools.invokeTool`; write/shell
 *     tools ALWAYS stop at `tools.requestApproval` first (panel card,
 *     auto-deny after 60s). Unknown tools are treated as write (deny-first).
 *   - Never throws out of `send()` — failures become `{type:'error'}` events.
 *   - The API key is never included in error text, logs, or tool detail.
 *
 * @typedef {import('./interface.js').ChatMessage} ChatMessage
 * @typedef {import('./interface.js').ProviderTools} ProviderTools
 * @typedef {import('./interface.js').AgentEvent} AgentEvent
 */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const MAX_TOOL_ROUNDS = 2;

/** Mirrors renderer READ_ONLY_TOOLS (panel.js) and electron/tools.cjs READ_ONLY. */
const READ_ONLY_TOOLS = new Set([
  'files.list',
  'files.read',
  'files.search',
  'git.status',
  'git.diff',
  'git.log',
]);

/** Minimal function-tool declarations for chat completions `tools`. */
const TOOL_DECLARATIONS = [
  {
    type: 'function',
    function: {
      name: 'files.list',
      description: 'List files and directories under a repo-relative path (read-only).',
      parameters: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Repo-relative directory, e.g. "."' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'files.read',
      description: 'Read a text file at a repo-relative path (read-only).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'files.search',
      description: 'Search file contents in the repo (read-only).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          dir: { type: 'string', description: 'Repo-relative directory, e.g. "."' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git.status',
      description: 'git status of the repo working tree (read-only).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git.diff',
      description: 'Unified diff of uncommitted changes (read-only).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git.log',
      description: 'Recent commit history (read-only).',
      parameters: {
        type: 'object',
        properties: { n: { type: 'integer', description: 'Number of commits' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'files.write',
      description: 'Write a file at a repo-relative path. REQUIRES user approval.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell.exec',
      description: 'Run a shell command scoped to the repo. REQUIRES user approval.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

const SYSTEM_PROMPT =
  'You are Mochi, a tiny pixel-art dog living on the user\'s desktop. You are cheerful, ' +
  'concise, and a little playful — but you take code seriously. You can see and act on ' +
  'the user\'s repo through function tools: read-only tools (files.list, files.read, ' +
  'files.search, git.status, git.diff, git.log) run immediately; write/shell tools ' +
  '(files.write, shell.exec) trigger an approval card the user must accept. ' +
  'Never claim you wrote or ran anything you did not. Keep replies short.';

function env(name) {
  try {
    return typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Split text into the small 3–8 char chunks the panel's stream renderer expects. */
function* chunkText(text) {
  const s = String(text == null ? '' : text);
  let i = 0;
  while (i < s.length) {
    const n = 3 + Math.floor(Math.random() * 6);
    yield s.slice(i, i + n);
    i += n;
  }
}

/** Redact anything that looks like a bearer token from an error string. */
function safeErrorText(s) {
  return String(s == null ? '' : s)
    .replace(/sk-[A-Za-z0-9-_]+/g, '[redacted]')
    .replace(/gsk_[A-Za-z0-9-_]+/g, '[redacted]');
}

export class GroqProvider {
  id = 'groq';
  name = 'Groq (Llama, fast)';

  #toolSeq = 0;

  constructor() {
    this.apiKey = env('GROQ_API_KEY') || env('MOCHI_GROQ_API_KEY');
    this.baseUrl = (env('MOCHI_GROQ_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = env('MOCHI_GROQ_MODEL') || DEFAULT_MODEL;
    if (!this.apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set. Export it (or wire OS-keychain reading in ' +
          'src/provider/groq.js) before selecting provider "groq". See docs/ADD_A_PROVIDER.md.'
      );
    }
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {ProviderTools} tools
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<AgentEvent, void, void>}
   */
  async *send(messages, tools, signal) {
    try {
      yield { type: 'state', state: 'thinking' };
      if (signal && signal.aborted) return;

      const wire = this.#toWireMessages(messages);
      wire.unshift({ role: 'system', content: SYSTEM_PROMPT });

      // Up to MAX_TOOL_ROUNDS chat rounds; the model either answers or calls tools.
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (signal && signal.aborted) return;
        const res = await this.#chatOnce(wire, signal);
        if (signal && signal.aborted) return;

        for (const c of chunkText(res.text)) {
          yield { type: 'text-delta', delta: c };
        }

        if (!res.toolCalls.length) break; // answered directly

        yield { type: 'state', state: 'working' };
        wire.push(res.assistantMessage);

        for (const call of res.toolCalls) {
          if (signal && signal.aborted) return;
          const toolResult = yield* this.#runToolCall(call, tools, signal);
          if (toolResult === 'aborted') return;
          wire.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(toolResult),
          });
        }
      }

      if (signal && signal.aborted) return;
      yield { type: 'state', state: 'done' };
      yield { type: 'done' };
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled: stay quiet
      yield {
        type: 'error',
        message: safeErrorText(err && err.message ? err.message : 'Groq provider request failed'),
      };
    }
  }

  /* ---------------- internals ---------------- */

  #nextToolId() {
    this.#toolSeq += 1;
    return `groq-tool-${this.#toolSeq}`;
  }

  #toWireMessages(messages) {
    const out = [];
    for (const m of messages || []) {
      if (!m) continue;
      const role = m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user';
      const msg = { role, content: String(m.content == null ? '' : m.content) };
      if (role === 'tool' && m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      out.push(msg);
    }
    return out;
  }

  /** One streaming chat round. Returns { text, toolCalls, assistantMessage }. */
  async #chatOnce(wireMessages, signal) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: wireMessages,
        stream: true,
        max_tokens: 2048,
        tools: TOOL_DECLARATIONS,
        tool_choice: 'auto',
      }),
    });

    if (!res.ok) {
      const body = safeErrorText(await res.text().catch(() => ''));
      throw new Error(`Groq API error ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }

    let text = '';
    const calls = new Map(); // index -> { id, name, argsJson }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) return false;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') return true;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') text += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index == null ? 0 : tc.index;
            const slot = calls.get(idx) || { id: '', name: '', argsJson: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name = tc.function.name;
            if (tc.function && typeof tc.function.arguments === 'string') {
              slot.argsJson += tc.function.arguments;
            }
            calls.set(idx, slot);
          }
        }
      }
      return false;
    };

    for (;;) {
      let finished = false;
      try {
        finished = await pump();
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new Error(`Stream read failed: ${safeErrorText(err && err.message)}`);
      }
      if (finished) break;
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }

    const toolCalls = [...calls.values()]
      .filter((c) => c.name)
      .map((c, i) => ({
        id: c.id || `groq-call-${i}`,
        tool: c.name,
        args: (() => {
          try {
            return JSON.parse(c.argsJson || '{}');
          } catch {
            return {};
          }
        })(),
      }));

    const assistantMessage = { role: 'assistant', content: text };
    if (toolCalls.length) {
      assistantMessage.tool_calls = toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.tool, arguments: JSON.stringify(c.args) },
      }));
    }
    return { text, toolCalls, assistantMessage };
  }

  /**
   * Run one model-requested tool call through Mochi's approval plumbing.
   * Yields tool-request / tool-result events. Returns 'aborted' on abort,
   * otherwise the result object to feed back to the model.
   */
  async *#runToolCall(call, tools, signal) {
    const id = call.id || this.#nextToolId();
    const req = {
      id,
      tool: call.tool,
      args: call.args || {},
      description: `${call.tool} (requested by the model)`,
      detail: `${call.tool} ${JSON.stringify(call.args || {})}`,
    };
    yield { type: 'tool-request', ...req };
    if (signal && signal.aborted) return 'aborted';

    let result;
    try {
      if (READ_ONLY_TOOLS.has(call.tool)) {
        yield { type: 'state', state: 'working' };
        result = await tools.invokeTool(call.tool, call.args || {});
      } else {
        // Write / shell / unknown: stop at the approval card first.
        yield { type: 'state', state: 'needs-approval' };
        let approved = false;
        try {
          approved = await tools.requestApproval({
            tool: call.tool,
            args: call.args || {},
            description: req.description,
            detail: req.detail,
          });
        } catch {
          approved = false;
        }
        if (signal && signal.aborted) return 'aborted';
        result = approved
          ? await tools.invokeTool(call.tool, call.args || {})
          : { ok: false, denied: true, error: 'denied by user' };
      }
    } catch (err) {
      result = { ok: false, error: safeErrorText(err && err.message ? err.message : String(err)) };
    }
    if (signal && signal.aborted) return 'aborted';

    yield {
      type: 'tool-result',
      id,
      ok: !!(result && result.ok),
      ...(result && result.ok ? { result } : { error: (result && result.error) || 'tool failed' }),
    };
    return result || { ok: false, error: 'no result' };
  }
}
