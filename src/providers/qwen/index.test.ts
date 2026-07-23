import assert from 'node:assert/strict';
import test from 'node:test';
import { isQwenRateLimitError, QwenRequestGate, reconcileQwenContent } from './index.js';

test('Qwen request gate limits concurrent upstream requests', async () => {
  const gate = new QwenRequestGate(1);
  const signal = new AbortController().signal;
  const releaseFirst = await gate.acquire(signal, 1_000);
  let secondResolved = false;
  const second = gate.acquire(signal, 1_000).then((release) => {
    secondResolved = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondResolved, false);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondResolved, true);
  releaseSecond();
});

test('Qwen request gate times out queued requests', async () => {
  const gate = new QwenRequestGate(1);
  const signal = new AbortController().signal;
  const releaseFirst = await gate.acquire(signal, 1_000);

  await assert.rejects(
    () => gate.acquire(signal, 5),
    /Qwen concurrency queue exceeded 5ms/
  );

  releaseFirst();
});

test('detects Qwen rate limit errors', () => {
  assert.equal(isQwenRateLimitError(Object.assign(new Error('anything'), { statusCode: 429 })), true);
  assert.equal(isQwenRateLimitError(new Error("Qwen upstream error: RateLimited: You've reached the upper limit for today's usage.")), true);
  assert.equal(isQwenRateLimitError(new Error('Qwen request timeout')), false);
});

test('reconciles incremental Qwen answer chunks', () => {
  assert.equal(reconcileQwenContent('Hello ', 'world'), 'Hello world');
});

test('reconciles cumulative Qwen answer snapshots', () => {
  assert.equal(reconcileQwenContent('[tool_calls] {"name":', '[tool_calls] {"name":"terminal"}'), '[tool_calls] {"name":"terminal"}');
});

test('replaces a revised cumulative snapshot instead of interleaving it', () => {
  const previous = '[tool_calls] [{"name":"delegate_task","arguments":{"goal":"Cri';
  const revised = '[tool_calls] [{"name":"delegate_task","arguments":{"goal":"Criar arquivo"}}]';
  assert.equal(reconcileQwenContent(previous, revised), revised);
});

test('ignores a repeated trailing chunk', () => {
  assert.equal(reconcileQwenContent('Execute PARALLEL_C_OK', 'PARALLEL_C_OK'), 'Execute PARALLEL_C_OK');
});
