/**
 * @module provider/mock
 *
 * MockProvider — friendly offline dog companion chatbot.
 * Streams replies with a playful, loyal Japanese dog personality.
 * Zero external network calls, zero API keys required.
 */

const FAST = typeof process !== 'undefined' && process.env && process.env.MOCHI_MOCK_FAST === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOG_RESPONSES = [
  "Woof! *wags tail excitedly* I'm right here keeping you company while you work. Need to brainstorm something, or just taking a quick breather?",
  "*tilts head curiously* That's really interesting! Tell me more about it. I'm all ears — literally, look at these fluffy ears!",
  "*happy pant* You're doing great! Remember to drink some water and give your eyes a little rest from the screen when you can.",
  "Woof! Did someone say snack break? No? Just coding? Okay, I'll happily keep watch from right here on your desktop.",
  "*stretches paws* Always happy to chat with you! Working on an exciting project today?",
  "*perks ears up* I might just be a desktop pup, but I believe in you! What are we focusing on next?",
];

function pickResponse(userText, userName) {
  const text = (userText || '').toLowerCase().trim();
  const greeting = userName ? `Woof, ${userName}!` : 'Woof!';

  if (!text) {
    return `${greeting} *wags tail* I'm Mochi, your desktop companion! How can I help you today?`;
  }

  if (text.includes('hello') || text.includes('hi') || text.includes('hey') || text.includes('mochi')) {
    return `${greeting} *happy tail wag* Great to see you! What's on your mind?`;
  }

  if (text.includes('who are you') || text.includes('what are you')) {
    return "I'm Mochi! A friendly Japanese dog companion living right on your screen. I love wandering around, napping, and chatting with you whenever you click on me.";
  }

  if (text.includes('good dog') || text.includes('good boy') || text.includes('cute') || text.includes('love you')) {
    return "*blushes and wags tail vigorously* Thank you! That makes my day! *does a little happy spin*";
  }

  if (text.includes('treat') || text.includes('bone') || text.includes('food')) {
    return "*ears perk straight up* Did you say treat?! *paws at the glass* A virtual bone would be delightful right now!";
  }

  if (text.includes('bye') || text.includes('sleep') || text.includes('night')) {
    return "*curls up into a fluffy ball* Rest well! I'll take a little snooze right here. See you soon! zzz...";
  }

  if (text.includes('help') || text.includes('what can you do')) {
    return "I'm your desktop dog companion! You can:\n• Click me anytime to chat\n• Drag me anywhere on your screen\n• Let me wander around while you work\n• Change my size or settings whenever you like\n• Connect a real AI provider in settings for full LLM conversations!";
  }

  // Pick a random fun dog reply
  const idx = Math.floor(Math.random() * DOG_RESPONSES.length);
  return `${greeting} ${DOG_RESPONSES[idx]}`;
}

export class MockProvider {
  id = 'mock';
  name = 'Mochi (Offline Mock)';

  /**
   * @param {import('./interface.js').ChatMessage[]} messages
   * @param {object} [tools]
   * @param {AbortSignal} [signal]
   * @param {object} [meta]
   * @returns {AsyncGenerator<import('./interface.js').AgentEvent, void, void>}
   */
  async *send(messages, tools, signal, meta = {}) {
    const lastUser = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
    const raw = lastUser && lastUser.content != null ? String(lastUser.content) : '';
    const text = raw.trim();

    yield { type: 'state', state: 'thinking' };
    await sleep(FAST ? 0 : 200 + Math.random() * 250);
    if (signal && signal.aborted) return;

    if (text.toLowerCase() === 'test error') {
      yield { type: 'error', message: 'Simulated test error.' };
      return;
    }

    const reply = pickResponse(text, meta.userName);
    yield* this.#streamText(reply, signal);
    if (signal && signal.aborted) return;

    yield { type: 'state', state: 'done' };
    yield { type: 'done' };
  }

  /** Stream text in 3–8 char deltas with brief delays. Stops on abort. */
  async *#streamText(text, signal) {
    let i = 0;
    const s = String(text);
    while (i < s.length) {
      if (signal && signal.aborted) return;
      const n = 3 + Math.floor(Math.random() * 6);
      yield { type: 'text-delta', delta: s.slice(i, i + n) };
      i += n;
      await sleep(FAST ? 0 : 15 + Math.random() * 20);
    }
  }
}
