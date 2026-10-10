/**
 * @module provider/registry
 * Provider registry: maps config `provider` ids to constructors.
 * Only `mock` ships with Mochi (no API keys, no network). To add a real
 * provider, see docs/ADD_A_PROVIDER.md and register it here.
 */

import { MockProvider } from './mock.js';

/** @type {Record<string, () => import('./interface.js').AgentProvider>} */
export const providers = {
  mock: () => new MockProvider(),
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
      `Unknown provider "${id}". Only "mock" is bundled. ` +
        'See docs/ADD_A_PROVIDER.md for how to add a provider.'
    );
  }
  return make();
}
