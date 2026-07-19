import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHermesProfile, createDefaultConfig } from './config.js';

test('Hermes profile clamps legacy context settings and extends upstream timeouts', () => {
  const config = createDefaultConfig();
  config.context.maxHistoryMessages = 50;
  config.context.maxInputChars = 200_000;
  config.context.maxSystemChars = 80_000;
  config.context.maxToolResultChars = 20_000;
  config.context.exposeReasoning = true;
  config.providers.qwen.requestTimeoutMs = 120_000;
  config.providers.qwen.idleTimeoutMs = 45_000;

  applyHermesProfile(config);

  assert.equal(config.context.maxHistoryMessages, 20);
  assert.equal(config.context.maxInputChars, 64_000);
  assert.equal(config.context.maxSystemChars, 24_000);
  assert.equal(config.context.maxToolResultChars, 8_000);
  assert.equal(config.context.exposeReasoning, false);
  assert.equal(config.providers.qwen.requestTimeoutMs, 180_000);
  assert.equal(config.providers.qwen.idleTimeoutMs, 75_000);
});
