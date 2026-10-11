/**
 * scripts/test-mock.cjs — drives MockProvider.send() through every trigger
 * and asserts the event-type sequences. Run: node scripts/test-mock.cjs
 *
 * Genuinely useful: guards the provider/panel event contract
 * (see src/provider/interface.js) against regressions.
 */
const assert = require('assert');

process.env.MOCHI_MOCK_FAST = '1'; // no streaming delays under test

function fakeTools({ approve = true } = {}) {
  return {
    invoked: [],
    approvals: [],
    async invokeTool(name, args) {
      this.invoked.push({ name, args });
      if (name === 'files.list') {
        return { ok: true, dir: '.', entries: [{ name: 'PLAN.md', type: 'file' }] };
      }
      if (name === 'files.write') {
        return { ok: true, path: args.path, bytes: 10, existed: false };
      }
      return { ok: true };
    },
    async requestApproval(info) {
      this.approvals.push(info);
      return approve;
    },
  };
}

async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

const types = (events) => events.map((e) => e.type);
const textOf = (events) =>
  events.filter((e) => e.type === 'text-delta').map((e) => e.delta).join('');

function checkSequence(name, events, expected) {
  const got = types(events);
  assert.deepStrictEqual(
    got.filter((t) => t !== 'text-delta'),
    expected,
    `${name}: structural sequence mismatch\n  got: ${got.join(',')}`
  );
  return events;
}

async function main() {
  const { MockProvider } = await import('../src/provider/mock.js');
  const { validateEvent } = await import('../src/provider/interface.js');

  // --- 1. plain message ---
  {
    const p = new MockProvider();
    assert.strictEqual(p.id, 'mock');
    assert.strictEqual(p.name, 'Mock (offline demo)');
    const tools = fakeTools();
    const events = await collect(p.send([{ role: 'user', content: 'hello' }], tools));
    checkSequence('plain', events, ['state', 'state', 'done']);
    assert.strictEqual(events[0].state, 'thinking');
    assert.strictEqual(events[events.length - 2].state, 'done');
    const text = textOf(events);
    assert.ok(text.length > 50, 'plain reply should be a friendly canned paragraph');
    assert.ok(text.includes('demo tool'), 'plain reply should hint at demo triggers');
    assert.strictEqual(tools.invoked.length, 0, 'plain reply must not call tools');
    for (const e of events) assert.ok(validateEvent(e).ok, `invalid event: ${JSON.stringify(e)}`);
    console.log('ok 1 - plain message: thinking -> deltas -> done, no tool calls');
  }

  // --- 2. demo tool ---
  {
    const p = new MockProvider();
    const tools = fakeTools();
    const events = await collect(p.send([{ role: 'user', content: 'please DEMO TOOL now' }], tools));
    checkSequence('demo tool', events, ['state', 'state', 'tool-request', 'tool-result', 'state', 'done']);
    const req = events.find((e) => e.type === 'tool-request');
    assert.strictEqual(req.tool, 'files.list');
    assert.deepStrictEqual(req.args, { dir: '.' });
    assert.ok(tools.invoked.some((c) => c.name === 'files.list'), 'files.list must be invoked');
    const res = events.find((e) => e.type === 'tool-result');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.id, req.id, 'tool-result id must match tool-request id');
    assert.ok(textOf(events).includes('PLAN.md'), 'summary should mention listed files');
    for (const e of events) assert.ok(validateEvent(e).ok, `invalid event: ${JSON.stringify(e)}`);
    console.log('ok 2 - demo tool: files.list invoked, tool-result ok, summary streamed');
  }

  // --- 3. demo approval (approved) ---
  {
    const p = new MockProvider();
    const tools = fakeTools({ approve: true });
    const events = await collect(p.send([{ role: 'user', content: 'demo approval please' }], tools));
    checkSequence('demo approval/yes', events, ['state', 'tool-request', 'state', 'tool-result', 'state', 'done']);
    const states = events.filter((e) => e.type === 'state').map((e) => e.state);
    assert.deepStrictEqual(states, ['thinking', 'needs-approval', 'done']);
    const req = events.find((e) => e.type === 'tool-request');
    assert.strictEqual(req.tool, 'files.write');
    assert.strictEqual(tools.approvals.length, 1, 'requestApproval must be awaited');
    assert.ok(tools.invoked.some((c) => c.name === 'files.write'), 'write must run after approval');
    assert.strictEqual(events.find((e) => e.type === 'tool-result').ok, true);
    for (const e of events) assert.ok(validateEvent(e).ok, `invalid event: ${JSON.stringify(e)}`);
    console.log('ok 3 - demo approval (yes): needs-approval -> approved -> write ran');
  }

  // --- 4. demo approval (denied) ---
  {
    const p = new MockProvider();
    const tools = fakeTools({ approve: false });
    const events = await collect(p.send([{ role: 'user', content: 'demo approval' }], tools));
    checkSequence('demo approval/no', events, ['state', 'tool-request', 'state', 'tool-result', 'state', 'done']);
    assert.ok(!tools.invoked.some((c) => c.name === 'files.write'), 'write must NOT run when denied');
    const res = events.find((e) => e.type === 'tool-result');
    assert.strictEqual(res.ok, false);
    assert.ok(textOf(events).toLowerCase().includes('denied'), 'summary should acknowledge denial');
    console.log('ok 4 - demo approval (no): denied -> write skipped, tool-result ok:false');
  }

  // --- 5. demo error ---
  {
    const p = new MockProvider();
    const events = await collect(p.send([{ role: 'user', content: 'demo error' }], fakeTools()));
    checkSequence('demo error', events, ['state', 'error']);
    assert.strictEqual(events[1].message, 'Mock provider simulated error');
    assert.ok(!types(events).includes('done'), 'no done event after error');
    console.log('ok 5 - demo error: error event, stream stops, no done');
  }

  // --- 6. quick actions ---
  {
    const p = new MockProvider();
    for (const q of ['Explain this repo', 'What changed recently?', 'Find a bug', 'Write tests for…', 'Review my diff']) {
      const events = await collect(p.send([{ role: 'user', content: q }], fakeTools()));
      const text = textOf(events);
      assert.ok(text.length > 20, `quick action "${q}" should produce a canned answer`);
      assert.ok(types(events).includes('done'), `quick action "${q}" should end with done`);
    }
    console.log('ok 6 - quick actions: all five produce canned answers ending in done');
  }

  // --- 7. abort ---
  {
    const p = new MockProvider();
    const c = new AbortController();
    c.abort();
    const events = await collect(p.send([{ role: 'user', content: 'hello' }], fakeTools(), c.signal));
    assert.deepStrictEqual(types(events), ['state'], 'aborted stream must stop after thinking');
    console.log('ok 7 - abort: pre-aborted signal stops the stream immediately');
  }

  // --- 8. validateEvent sanity ---
  {
    assert.ok(!validateEvent({ type: 'nope' }).ok);
    assert.ok(!validateEvent({ type: 'state', state: 'napping' }).ok);
    assert.ok(validateEvent({ type: 'done' }).ok);
    console.log('ok 8 - validateEvent rejects bad shapes');
  }

  console.log('\nAll mock provider tests passed.');
}

main().catch((e) => {
  console.error('TEST FAILURE:', e);
  process.exit(1);
});
