import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig, type ProviderId } from '../config.js';
import type { ProviderStreamEvent } from '../types.js';
import { ProviderRegistry, type ProviderFactory } from './registry.js';
import type { ProviderAdapter, ProviderRequest } from './types.js';

class FakeProvider implements ProviderAdapter {
  readonly idleTimeoutMs = 42_000;

  constructor(readonly id: ProviderId) {}

  async authStatus() {
    return { authenticated: true, detail: 'test' };
  }

  async listModels() {
    return [{
      id: `${this.id}/model`,
      provider: this.id,
      ownedBy: this.id,
      capabilities: { streaming: true, tools: true, reasoning: false, vision: false }
    }];
  }

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'done' };
  }

  async close() {}
}

test('registry creates only enabled providers and resolves explicit prefixes', () => {
  const config = createDefaultConfig();
  config.providers.kimi.enabled = true;
  const factories: Partial<Record<ProviderId, ProviderFactory>> = {
    qwen: () => new FakeProvider('qwen'),
    kimi: () => new FakeProvider('kimi')
  };

  const registry = new ProviderRegistry(config, factories);

  assert.deepEqual(registry.entries().map(([id]) => id), ['qwen', 'kimi']);
  assert.equal(registry.resolve('kimi/model').provider.id, 'kimi');
  assert.equal(registry.resolve('legacy-model').provider.id, 'qwen');
  assert.equal(registry.get('chatgpt'), undefined);
});

test('registry fails early when an enabled provider has no adapter', () => {
  const config = createDefaultConfig();
  config.providers.gemini.enabled = true;
  assert.throws(() => new ProviderRegistry(config), /enabled but not implemented: gemini/);
});
