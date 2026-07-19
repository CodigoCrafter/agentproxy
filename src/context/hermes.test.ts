import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../config.js';
import { buildHermesPrompt } from './hermes.js';

test('Hermes prompt does not reinsert assistant reasoning', () => {
  const config = createDefaultConfig();
  const result = buildHermesPrompt({
    model: 'qwen/test',
    messages: [
      { role: 'system', content: 'Follow the project rules.' },
      { role: 'assistant', content: 'Visible answer', reasoning_content: 'private chain of thought' },
      { role: 'user', content: 'Continue' }
    ]
  }, config.context);

  assert.match(result.prompt, /Visible answer/);
  assert.doesNotMatch(result.prompt, /private chain of thought/);
});

test('Hermes prompt keeps recent messages and truncates large tool output', () => {
  const config = createDefaultConfig();
  config.context.maxHistoryMessages = 3;
  config.context.maxToolResultChars = 100;
  const result = buildHermesPrompt({
    messages: [
      { role: 'system', content: 'Rules' },
      { role: 'user', content: 'old message' },
      { role: 'assistant', content: 'old answer' },
      { role: 'tool', name: 'read_file', content: 'x'.repeat(1_000) },
      { role: 'user', content: 'latest request' }
    ]
  }, config.context);

  assert.doesNotMatch(result.prompt, /old message/);
  assert.match(result.prompt, /latest request/);
  assert.match(result.prompt, /AgentProxy compacted tool output/);
  assert.ok(result.prompt.length < 500);
});

test('Hermes prompt injects compact tool definitions', () => {
  const config = createDefaultConfig();
  const result = buildHermesPrompt({
    messages: [{ role: 'user', content: 'Read a file' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Reads a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }
    }]
  }, config.context);

  assert.match(result.prompt, /<tool_call>/);
  assert.match(result.prompt, /read_file/);
  assert.ok(result.prompt.length < 1_000);
});

test('Hermes prompt preserves nested tool schemas after compaction', () => {
  const config = createDefaultConfig();
  config.context.maxInputChars = 3_000;
  config.context.maxSystemChars = 500;
  const noisyProperties = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
    `optional_${index}`,
    { type: 'string', description: 'x'.repeat(200) }
  ]));
  const result = buildHermesPrompt({
    messages: [{ role: 'user', content: 'Delegate the task.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'delegate_task',
        description: 'Creates subagents. '.repeat(30),
        parameters: {
          type: 'object',
          properties: {
            ...noisyProperties,
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: { goal: { type: 'string', description: 'Required subagent goal' } },
                required: ['goal']
              }
            }
          },
          required: ['tasks']
        }
      }
    }]
  }, config.context);

  assert.match(result.prompt, /"tasks":\{"type":"array","items":\{"type":"object"/);
  assert.match(result.prompt, /"goal":\{"type":"string"\}/);
  assert.match(result.prompt, /"required":\["goal"\]/);
  assert.doesNotMatch(result.prompt, /Required subagent goal/);
});

test('Hermes prompt compacts huge system context without losing current work', () => {
  const config = createDefaultConfig();
  config.context.maxInputChars = 1_200;
  config.context.maxSystemChars = 500;
  const result = buildHermesPrompt({
    messages: [
      { role: 'system', content: `SYSTEM_HEAD\n${'stale-memory '.repeat(500)}\nSYSTEM_TAIL` },
      { role: 'user', content: 'Run the terminal command now.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_123', function: { name: 'terminal', arguments: '{"command":"printf OK"}' } }]
      },
      { role: 'tool', name: 'terminal', tool_call_id: 'call_123', content: '{"output":"OK","exit_code":0}' }
    ]
  }, config.context);

  assert.ok(result.prompt.length <= config.context.maxInputChars);
  assert.match(result.prompt, /SYSTEM_HEAD/);
  assert.match(result.prompt, /SYSTEM_TAIL/);
  assert.match(result.prompt, /Run the terminal command now/);
  assert.match(result.prompt, /call_123/);
  assert.match(result.prompt, /"output":"OK"/);
  assert.match(result.prompt, /oversized system context/);
});
