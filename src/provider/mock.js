/**
 * @module provider/mock
 *
 * MockProvider — the only bundled provider. Fully offline: canned replies,
 * simulated streaming delays, and demo triggers that exercise the real tool
 * and approval plumbing end-to-end. No API keys, no vendor SDKs, no network.
 *
 * Demo triggers (matched case-insensitively against the last user message):
 * - `demo tool`     → runs read-only `files.list` via tools.invokeTool, shows tool events.
 * - `demo approval` → requests `files.write`; yields needs-approval and awaits
 *                     tools.requestApproval(info) before continuing.
 * - `demo error`    → yields an error event and stops.
 */

const FAST = typeof process !== 'undefined' && process.env && process.env.MOCHI_MOCK_FAST === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_REPLY =
  "Hey! I'm Mochi, your offline pixel-dog pal. I can see your repo right here — " +
  'no keys, no cloud, just vibes. Try a quick action below, or whisper ' +
  '`demo tool` to watch me list your files, `demo approval` to see the approval ' +
  'card in action, or `demo error` to see how I handle a grumpy provider.';

/** Tool calls are best-effort in canned answers: never let a tool failure break the reply. */
async function safeInvoke(tools, name, args) {
  try {
    const res = await tools.invokeTool(name, args);
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}

function namesOf(listRes, n = 8) {
  const entries = listRes && Array.isArray(listRes.entries) ? listRes.entries : [];
  return entries
    .slice(0, n)
    .map((e) => (e.type === 'dir' ? e.name + '/' : e.name))
    .join(', ');
}

const QUICK_ACTIONS = {
  'explain this repo': async (tools) => {
    const list = await safeInvoke(tools, 'files.list', { dir: '.' });
    const names = namesOf(list);
    return (
      'This is Mochi — an Electron pixel-dog desktop companion. The renderer is vanilla ' +
      'JS on canvas (chunky pixels, no frameworks), the brain is a swappable *provider* ' +
      '(right now just me, the Mock — fully offline, no API keys, no cloud), and tools run ' +
      'locally against your repo root. Anything that writes or runs shell needs your approval first.' +
      (names ? ` Top-level entries I can see: ${names}.` : '')
    );
  },
  'what changed recently?': async (tools) => {
    const log = await safeInvoke(tools, 'git.log', { n: 5 });
    const status = await safeInvoke(tools, 'git.status', {});
    let out = '';
    if (log && Array.isArray(log.commits) && log.commits.length) {
      out += 'Freshest commits:\n' + log.commits.map((c) => `- ${c.hash} ${c.subject}`).join('\n');
    } else {
      out += 'No git history I could read (fresh repo, maybe?).';
    }
    if (status) {
      const dirty = Array.isArray(status.files) ? status.files.length : 0;
      out += dirty ? `\nWorking tree: ${dirty} changed file(s).` : '\nWorking tree: clean.';
    }
    return out;
  },
  'find a bug': async () =>
    "I sniffed around the codebase and didn't find a real bug — but I'm a mock, so take " +
    'that with a grain of kibble. Want to see my error handling instead? Type `demo error`.',
  'write tests for…': async () =>
    'Tell me which file you want tests for (e.g. `src/state/mochiState.js`) and I\'ll draft ' +
    'a test plan. Heads-up: I can\'t write files without your approval — type `demo approval` ' +
    'to see the approval card first.',
  'review my diff': async (tools) => {
    const diff = await safeInvoke(tools, 'git.diff', {});
    if (diff && typeof diff.diff === 'string' && diff.diff.trim()) {
      const files = diff.diff
        .split('\n')
        .filter((l) => l.startsWith('diff --git'))
        .map((l) => l.replace('diff --git a/', '').split(' b/')[0]);
      return (
        `I see changes in ${files.length} file(s): ${files.join(', ')}.\n` +
        'Looks tidy from here — just make sure the pixel dog still blinks. (Full review mode ' +
        'arrives with a real provider; I\'m only the demo pup.)'
      );
    }
    return 'Working tree is clean — nothing to review! Make a change and ask again.';
  },
};

export class MockProvider {
  id = 'mock';
  name = 'Mock (offline demo)';

  #toolSeq = 0;

  /**
   * @param {import('./interface.js').ChatMessage[]} messages
   * @param {import('./interface.js').ProviderTools} tools
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<import('./interface.js').AgentEvent, void, void>}
   */
  async *send(messages, tools, signal) {
    const lastUser = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
    const raw = lastUser && lastUser.content != null ? String(lastUser.content) : '';
    const text = raw.trim();
    const lower = text.toLowerCase();

    yield { type: 'state', state: 'thinking' };
    await sleep(FAST ? 0 : 250 + Math.random() * 350);
    if (signal && signal.aborted) return;

    if (lower.includes('demo error')) {
      yield { type: 'error', message: 'Mock provider simulated error' };
      return;
    }
    if (lower.includes('demo approval')) {
      yield* this.#approvalDemo(tools, signal);
      return;
    }
    if (lower.includes('demo tool')) {
      yield* this.#toolDemo(tools, signal);
      return;
    }

    const quick = QUICK_ACTIONS[lower];
    if (quick) {
      const reply = await quick(tools);
      yield* this.#streamText(reply, signal);
      if (signal && signal.aborted) return;
      yield { type: 'state', state: 'done' };
      yield { type: 'done' };
      return;
    }

    yield* this.#streamText(DEFAULT_REPLY, signal);
    if (signal && signal.aborted) return;
    yield { type: 'state', state: 'done' };
    yield { type: 'done' };
  }

  /** Stream text in 3–8 char deltas with 20–40ms delays. Stops on abort. */
  async *#streamText(text, signal) {
    let i = 0;
    const s = String(text);
    while (i < s.length) {
      if (signal && signal.aborted) return;
      const n = 3 + Math.floor(Math.random() * 6);
      yield { type: 'text-delta', delta: s.slice(i, i + n) };
      i += n;
      await sleep(FAST ? 0 : 20 + Math.random() * 20);
    }
  }

  #nextToolId() {
    this.#toolSeq += 1;
    return `mock-tool-${this.#toolSeq}`;
  }

  /** `demo tool`: run read-only files.list through the panel's tools adapter. */
  async *#toolDemo(tools, signal) {
    yield { type: 'state', state: 'working' };
    const id = this.#nextToolId();
    const req = {
      id,
      tool: 'files.list',
      args: { dir: '.' },
      description: 'List files in the repo root (read-only)',
      detail: 'files.list {"dir": "."}',
    };
    yield { type: 'tool-request', ...req };

    let result;
    try {
      result = await tools.invokeTool(req.tool, req.args);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (signal && signal.aborted) return;
    yield {
      type: 'tool-result',
      id,
      ok: !!(result && result.ok),
      ...(result && result.ok ? { result } : { error: (result && result.error) || 'tool failed' }),
    };

    const names = namesOf(result, 10);
    const summary = names
      ? `Done! I listed the repo root with \`files.list\` — no approval needed since it's read-only. I can see: ${names}. Ask me to \`demo approval\` next to see the write path.`
      : 'The tool ran, but I got nothing useful back. The plumbing works though — ' +
        'tool-request went out and a tool-result came home.';
    yield* this.#streamText(summary, signal);
    if (signal && signal.aborted) return;
    yield { type: 'state', state: 'done' };
    yield { type: 'done' };
  }

  /** `demo approval`: request files.write; pause on needs-approval until the panel decides. */
  async *#approvalDemo(tools, signal) {
    const id = this.#nextToolId();
    const req = {
      id,
      tool: 'files.write',
      args: { path: 'demo/mochi-note.txt', content: 'Mochi was here! (demo note)\n' },
      description: 'Write a demo note file (needs your approval)',
      detail:
        'files.write {"path": "demo/mochi-note.txt"}\n--- new file ---\n+Mochi was here! (demo note)',
    };
    yield { type: 'tool-request', ...req };
    yield { type: 'state', state: 'needs-approval' };

    let approved = false;
    try {
      approved = await tools.requestApproval({
        tool: req.tool,
        args: req.args,
        description: req.description,
        detail: req.detail,
      });
    } catch {
      approved = false;
    }
    if (signal && signal.aborted) return;

    let result;
    if (approved) {
      try {
        result = await tools.invokeTool(req.tool, req.args);
      } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) };
      }
    } else {
      result = { ok: false, denied: true, error: 'denied by user' };
    }
    if (signal && signal.aborted) return;
    yield {
      type: 'tool-result',
      id,
      ok: !!(result && result.ok),
      ...(result && result.ok ? { result } : { error: result.error || 'tool failed' }),
    };

    const summary = approved
      ? 'You approved it — the note is written. That card you saw is the approval gate: ' +
        'every write or shell command stops there, and it auto-denies after 60 seconds if you wander off.'
      : 'You denied it (or the 60s timer did) — nothing was written. That\'s the approval gate ' +
        'doing its job: write and shell tools never run without an explicit yes.';
    yield* this.#streamText(summary, signal);
    if (signal && signal.aborted) return;
    yield { type: 'state', state: 'done' };
    yield { type: 'done' };
  }
}
