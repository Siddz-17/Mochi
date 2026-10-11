/**
 * @module provider/registry
 * Provider registry: maps config `provider` ids to constructors.
 * Ships with `mock` (no API keys, no network) and `groq`
 * (needs GROQ_API_KEY from https://console.groq.com).
 * To add another provider, see docs/ADD_A_PROVIDER.md and register it here.
 */

import { MockProvider } from './mock.js';
import { GroqProvider } from './groq.js';

/** @type {Record<string, () => import('./interface.js').AgentProvider>} */
export const providers = {
  mock: () => new MockProvider(),
  groq: () => new GroqProvider(),
};

/**
 * Instantiate a provider by id.
 * @param {string} id
 * @returns {import('./interface.js').AgentProvider}
 * @throws {Error} when the id is unknown, pointing at docs/ADD_A_PROVIDER.md.
 */
export function loadProvider(id) {
  const make = providers[id];
  if (!make) {
    throw new Error(
      `Unknown provider "${id}". Bundled providers: "mock" and "groq". ` +
        'See docs/ADD_A_PROVIDER.md for how to add a provider.'
    );
  }
  return make();
}
