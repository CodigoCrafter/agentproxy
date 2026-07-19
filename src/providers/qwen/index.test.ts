import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileQwenContent } from './index.js';

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
