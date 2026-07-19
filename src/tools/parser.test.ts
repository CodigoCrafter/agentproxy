import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamingToolParser } from './parser.js';

test('parses a tool call split across stream chunks', () => {
  const parser = new StreamingToolParser();
  const first = parser.feed('Let me check.<tool_');
  const second = parser.feed('call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>');
  const final = parser.flush();

  assert.equal(first.text + second.text + final.text, 'Let me check.');
  assert.equal(second.toolCalls.length, 1);
  assert.equal(second.toolCalls[0].name, 'read_file');
  assert.deepEqual(second.toolCalls[0].arguments, { path: 'a.txt' });
});

test('returns malformed calls as ordinary text', () => {
  const parser = new StreamingToolParser();
  const output = parser.feed('<tool_call>{bad json}</tool_call>');
  assert.equal(output.toolCalls.length, 0);
  assert.match(output.text, /bad json/);
});

test('recovers a leaked bare JSON tool call on flush', () => {
  const parser = new StreamingToolParser(undefined, new Set(['terminal']));
  const first = parser.feed('{"name":"terminal","arguments":{"command":"printf OK"}}');
  const final = parser.flush();

  assert.equal(first.text + final.text, '');
  assert.equal(final.toolCalls.length, 1);
  assert.equal(final.toolCalls[0].name, 'terminal');
  assert.deepEqual(final.toolCalls[0].arguments, { command: 'printf OK' });
});

test('recovers leaked OpenAI-style tool calls', () => {
  const parser = new StreamingToolParser(undefined, new Set(['read_file']));
  const output = parser.feed('{"tool_calls":[{"type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}');
  const final = parser.flush();

  assert.equal(output.text + final.text, '');
  assert.equal(final.toolCalls.length, 1);
  assert.equal(final.toolCalls[0].name, 'read_file');
  assert.deepEqual(final.toolCalls[0].arguments, { path: 'a.txt' });
});

test('recovers leaked legacy tool_calls envelope split across chunks', () => {
  const parser = new StreamingToolParser(undefined, new Set(['delegate_task']));
  const first = parser.feed('[tool_');
  const second = parser.feed('calls] [{"id":"call_seq1","name":"delegate_task","arguments":{"goal":"SIMPLE_AGENT_OK","tasks":[{"goal":"SIMPLE_AGENT_OK"}]}}]');
  const final = parser.flush();

  assert.equal(first.text + second.text + final.text, '');
  assert.equal(final.toolCalls.length, 1);
  assert.equal(final.toolCalls[0].name, 'delegate_task');
  assert.deepEqual(final.toolCalls[0].arguments, {
    goal: 'SIMPLE_AGENT_OK',
    tasks: [{ goal: 'SIMPLE_AGENT_OK' }]
  });
});

test('recovers hybrid legacy envelope with an XML closing tag', () => {
  const parser = new StreamingToolParser(undefined, new Set(['delegate_task']));
  parser.feed('[tool_calls]\n');
  parser.feed('{"name":"delegate_task","arguments":{"goal":"SIMPLE_AGENT_OK","tasks":[{"goal":"SIMPLE_AGENT_OK"}]}}');
  const final = parser.feed('\n</tool_call>');
  const flushed = parser.flush();

  assert.equal(final.text + flushed.text, '');
  assert.equal(flushed.toolCalls.length, 1);
  assert.equal(flushed.toolCalls[0].name, 'delegate_task');
  assert.deepEqual(flushed.toolCalls[0].arguments.tasks, [{ goal: 'SIMPLE_AGENT_OK' }]);
});

test('recovers the legacy envelope with a plural XML closing tag', () => {
  const parser = new StreamingToolParser(undefined, new Set(['delegate_task']));
  parser.feed('[tool_calls]\n');
  parser.feed('{"name":"delegate_task","arguments":{"tasks":[{"goal":"PARALLEL_D_OK"}]}}');
  parser.feed('\n</tool_calls>');
  const final = parser.flush();

  assert.equal(final.text, '');
  assert.equal(final.malformedToolCall, undefined);
  assert.equal(final.toolCalls.length, 1);
  assert.deepEqual(final.toolCalls[0].arguments.tasks, [{ goal: 'PARALLEL_D_OK' }]);
});

test('recovers the legacy envelope with a bracket closing tag', () => {
  const parser = new StreamingToolParser(undefined, new Set(['delegate_task']));
  parser.feed('[tool_calls]\n');
  parser.feed('{"id":"call_fixed","name":"delegate_task","arguments":{"tasks":[{"goal":"ATOMIC_FILE_3_OK"}]}}');
  parser.feed('\n[/tool_calls]');
  const final = parser.flush();

  assert.equal(final.text, '');
  assert.equal(final.malformedToolCall, undefined);
  assert.equal(final.toolCalls.length, 1);
  assert.deepEqual(final.toolCalls[0].arguments.tasks, [{ goal: 'ATOMIC_FILE_3_OK' }]);
});

test('flags a truncated argument tail instead of leaking it as successful text', () => {
  const parser = new StreamingToolParser(undefined, new Set(['terminal']));
  parser.feed('command": "printf PARALLEL_C_OK", ');
  parser.feed('"workdir": "/mnt/c/Users/andre"}}');
  const final = parser.flush();

  assert.equal(final.text, '');
  assert.equal(final.toolCalls.length, 0);
  assert.match(final.malformedToolCall || '', /PARALLEL_C_OK/);
});

test('recovers consecutive bare calls with closing tags but no opening tags', () => {
  const parser = new StreamingToolParser(undefined, new Set(['todo', 'delegate_task']));
  parser.feed('{"name":"todo","arguments":{"todos":[]}}\n</tool_call>\n');
  parser.feed('{"name":"delegate_task","arguments":{"goal":"SIMPLE_AGENT_OK","role":"leaf"}}\n</tool_call>');
  const final = parser.flush();

  assert.equal(final.text, '');
  assert.equal(final.malformedToolCall, undefined);
  assert.deepEqual(final.toolCalls.map((call) => call.name), ['todo', 'delegate_task']);
});

test('recovers an allowed second call whose JSON name prefix was dropped', () => {
  const parser = new StreamingToolParser(undefined, new Set(['todo', 'terminal']));
  const first = parser.feed(
    '<tool_call>{"name":"todo","arguments":{"todos":[]}}</tool_call>\n'
      + 'terminal", "arguments": {"command": "printf DIR_READY"}}</tool_call>'
  );
  const final = parser.flush();

  assert.equal(first.text + final.text, '');
  assert.equal(final.malformedToolCall, undefined);
  assert.deepEqual(
    [...first.toolCalls, ...final.toolCalls].map((call) => call.name),
    ['todo', 'terminal']
  );
  assert.deepEqual(final.toolCalls[0].arguments, { command: 'printf DIR_READY' });
});

test('recovers multiple calls after one legacy envelope marker', () => {
  const parser = new StreamingToolParser(undefined, new Set(['todo', 'delegate_task']));
  const first = parser.feed('Prosseguindo com o teste.\n[tool_calls] ');
  parser.feed('{"name":"todo","arguments":{"merge":true}}\n');
  parser.feed('{"name":"delegate_task","arguments":{"goal":"FILE_AGENT_OK","role":"leaf"}}');
  const final = parser.flush();

  assert.equal(first.text, 'Prosseguindo com o teste.\n');
  assert.equal(final.malformedToolCall, undefined);
  assert.deepEqual(final.toolCalls.map((call) => call.name), ['todo', 'delegate_task']);
});

test('flags an interleaved legacy block as malformed instead of leaking it', () => {
  const parser = new StreamingToolParser(undefined, new Set(['delegate_task']));
  parser.feed('[tool_calls] {"name":"delegate_task","arguments":{"goal":"Cri');
  parser.feed('[tool_calls] {"name":"delegate_task","arguments":{"goal":"arquivo"}}');
  const final = parser.flush();

  assert.equal(final.text, '');
  assert.equal(final.toolCalls.length, 0);
  assert.match(final.malformedToolCall || '', /delegate_task/);
});

test('recovers leaked fenced JSON but rejects tools not offered by the client', () => {
  const parser = new StreamingToolParser(undefined, new Set(['read_file']));
  const output = parser.feed('```json\n{"name":"terminal","arguments":{"command":"whoami"}}\n```');
  const final = parser.flush();

  assert.equal(output.toolCalls.length + final.toolCalls.length, 0);
  assert.match(output.text + final.text, /terminal/);
});
