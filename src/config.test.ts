import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHermesProfile, createDefaultConfig, mergeConfig, providerIds } from './config.js';

test('Hermes profile clamps legacy context settings and extends upstream timeouts', () => {
  const config = createDefaultConfig();
  config.context.maxHistoryMessages = 50;
  config.context.maxInputChars = 200_000;
  config.context.maxSystemChars = 80_000;
  config.context.maxToolResultChars = 20_000;
  config.context.exposeReasoning = true;
  config.providers.qwen.requestTimeoutMs = 120_000;
  config.providers.qwen.idleTimeoutMs = 45_000;
  config.providers.kimi.requestTimeoutMs = 90_000;
  config.providers.kimi.idleTimeoutMs = 30_000;

  applyHermesProfile(config);

  assert.equal(config.context.maxHistoryMessages, 16);
  assert.equal(config.context.maxInputChars, 64_000);
  assert.equal(config.context.maxSystemChars, 24_000);
  assert.equal(config.context.maxToolResultChars, 4_000);
  assert.equal(config.context.exposeReasoning, false);
  assert.equal(config.providers.qwen.requestTimeoutMs, 180_000);
  assert.equal(config.providers.qwen.idleTimeoutMs, 75_000);
  assert.equal(config.providers.qwen.maxConcurrentRequests, 2);
  assert.equal(config.providers.qwen.queueTimeoutMs, 120_000);
  assert.equal(config.providers.qwen.rateLimitCooldownMs, 30 * 60_000);
  assert.equal(config.providers.kimi.requestTimeoutMs, 180_000);
  assert.equal(config.providers.kimi.idleTimeoutMs, 75_000);
});

test('default configuration keeps new providers disabled', () => {
  const config = createDefaultConfig();
  assert.equal(config.providers.qwen.enabled, true);
  for (const providerId of providerIds.filter((id) => id !== 'qwen')) {
    assert.equal(config.providers[providerId].enabled, false);
  }
});

test('legacy Qwen-only configuration receives multi-provider defaults', () => {
  const base = createDefaultConfig();
  const config = mergeConfig(base, {
    defaultModel: 'qwen/legacy-model',
    providers: {
      qwen: { idleTimeoutMs: 91_000 }
    }
  });

  assert.equal(config.defaultModel, 'qwen/legacy-model');
  assert.equal(config.providers.qwen.idleTimeoutMs, 91_000);
  assert.equal(config.providers.qwen.maxConcurrentRequests, 2);
  assert.equal(config.providers.qwen.queueTimeoutMs, 120_000);
  assert.equal(config.providers.qwen.rateLimitCooldownMs, 30 * 60_000);
  assert.equal(config.providers.kimi.enabled, false);
  assert.equal(config.providers.chatgpt.enabled, false);
  assert.equal(config.providers.gemini.enabled, false);
});
