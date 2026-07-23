import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDefaultConfig } from '../config.js';
import type { ProviderAdapter, ProviderRequest } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderStreamEvent } from '../types.js';
import { createApiServer } from './http.js';

class FakeProvider implements ProviderAdapter {
  readonly id = 'qwen';
  readonly idleTimeoutMs = 12_345;
  lastRequest: ProviderRequest | null = null;

  async authStatus() { return { authenticated: true, detail: 'test' }; }
  async listModels() {
    return [{
      id: 'fake/model',
      provider: 'fake',
      ownedBy: 'test',
      capabilities: { streaming: true, tools: true, reasoning: false, vision: false }
    }];
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.lastRequest = request;
    yield { type: 'text', text: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' };
    yield { type: 'done' };
  }
  async close() {}
}

class FailingProvider extends FakeProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.lastRequest = request;
    throw Object.assign(new Error('Qwen account needs activation'), { statusCode: 400 });
  }
}

class MidStreamFailingProvider extends FakeProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.lastRequest = request;
    yield { type: 'text', text: 'partial response already delivered to the client' };
    throw new Error('Qwen returned an empty response');
  }
}

class ToolUnavailableProvider extends FakeProvider {
  modelsSeen: string[] = [];

  override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.lastRequest = request;
    this.modelsSeen.push(request.model);
    if (request.model.endsWith('-no-thinking')) {
      yield { type: 'text', text: '<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>' };
      yield { type: 'done' };
      return;
    }
    yield { type: 'text', text: 'Tool terminal does not exists.' };
    yield { type: 'done' };
  }
}

class SlowThinkingProvider extends FakeProvider {
  modelsSeen: string[] = [];

  override async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.lastRequest = request;
    this.modelsSeen.push(request.model);
    if (request.model.endsWith('-no-thinking')) {
      yield { type: 'text', text: '<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>' };
      yield { type: 'done' };
      return;
    }
    await waitForAbortOrDelay(request.signal, 1_000);
    yield { type: 'text', text: '<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>' };
    yield { type: 'done' };
  }
}

test('HTTP API authenticates requests and emits OpenAI tool calls', async () => {
  const home = await useTempAgentProxyHome();
  const config = createDefaultConfig();
  config.apiKey = 'test-key';
  const provider = new FakeProvider();
  const registry = {
    listModels: () => provider.listModels(),
    resolve: () => ({ provider, model: 'model' })
  } as unknown as ProviderRegistry;
  const server = createApiServer(config, registry, () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${base}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const completion = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake/model',
        messages: [
          { role: 'assistant', content: 'answer', reasoning_content: 'do not forward this' },
          { role: 'user', content: 'read it' }
        ]
      })
    });
    assert.equal(completion.status, 200);
    const body = await completion.json() as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> };
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_file');
    assert.doesNotMatch(provider.lastRequest?.prompt || '', /do not forward this/);
    assert.equal(provider.lastRequest?.idleTimeoutMs, provider.idleTimeoutMs);
    const telemetry = await readFile(path.join(home, 'logs', 'telemetry.jsonl'), 'utf8');
    assert.match(telemetry, /"type":"request_start"/);
    assert.match(telemetry, /"type":"request_end"/);
    assert.match(telemetry, /"toolNames":\[\]/);
    assert.doesNotMatch(telemetry, /read it|do not forward this/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreAgentProxyHome();
  }
});

test('HTTP streaming reports failures before output as an HTTP error', async () => {
  await useTempAgentProxyHome();
  const config = createDefaultConfig();
  config.apiKey = 'test-key';
  const provider = new FailingProvider();
  const registry = {
    listModels: () => provider.listModels(),
    resolve: () => ({ provider, model: 'model' })
  } as unknown as ProviderRegistry;
  const server = createApiServer(config, registry, () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const completion = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake/model', stream: true, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(completion.status, 400);
    const body = await completion.json() as { error: { message: string } };
    assert.match(body.error.message, /needs activation/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreAgentProxyHome();
  }
});


test('HTTP streaming reports failures after output as an SSE error', async () => {
  const home = await useTempAgentProxyHome();
  const config = createDefaultConfig();
  config.apiKey = 'test-key';
  const provider = new MidStreamFailingProvider();
  const registry = {
    listModels: () => provider.listModels(),
    resolve: () => ({ provider, model: 'model' })
  } as unknown as ProviderRegistry;
  const server = createApiServer(config, registry, () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const completion = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake/model', stream: true, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(completion.status, 200);
    const body = await completion.text();
    assert.match(body, /partial/);
    assert.match(body, /agentproxy_upstream_error/);
    assert.match(body, /data: \[DONE\]/);
    const telemetry = await readFile(path.join(home, 'logs', 'telemetry.jsonl'), 'utf8');
    assert.match(telemetry, /"type":"stream_error"/);
    assert.match(telemetry, /Qwen returned an empty response/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreAgentProxyHome();
  }
});

test('HTTP streaming falls back when thinking claims an available tool does not exist', async () => {
  await useTempAgentProxyHome();
  const config = createDefaultConfig();
  config.apiKey = 'test-key';
  config.defaultModel = 'qwen/qwen3.8-max-preview';
  const provider = new ToolUnavailableProvider();
  const registry = {
    listModels: () => provider.listModels(),
    resolve: (modelId: string) => ({ provider, model: modelId.replace(/^qwen\//, '') })
  } as unknown as ProviderRegistry;
  const server = createApiServer(config, registry, () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const completion = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-max-preview',
        stream: true,
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [{
          type: 'function',
          function: {
            name: 'terminal',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }
        }]
      })
    });
    assert.equal(completion.status, 200);
    const body = await completion.text();
    assert.deepEqual(provider.modelsSeen, ['qwen3.8-max-preview', 'qwen3.7-max-no-thinking']);
    assert.match(body, /qwen\/qwen3\.7-max-no-thinking/);
    assert.match(body, /"name":"terminal"/);
    assert.doesNotMatch(body, /does not exists/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreAgentProxyHome();
  }
});

test('HTTP streaming falls back when thinking prevalidation takes too long', async () => {
  await useTempAgentProxyHome();
  const previousTimeout = process.env.AGENTPROXY_THINKING_PREVALIDATE_TIMEOUT_MS;
  process.env.AGENTPROXY_THINKING_PREVALIDATE_TIMEOUT_MS = '20';
  const config = createDefaultConfig();
  config.apiKey = 'test-key';
  config.defaultModel = 'qwen/qwen3.8-max-preview';
  const provider = new SlowThinkingProvider();
  const registry = {
    listModels: () => provider.listModels(),
    resolve: (modelId: string) => ({ provider, model: modelId.replace(/^qwen\//, '') })
  } as unknown as ProviderRegistry;
  const server = createApiServer(config, registry, () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const started = performance.now();
    const completion = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-max-preview',
        stream: true,
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [{
          type: 'function',
          function: {
            name: 'terminal',
            parameters: { type: 'object', properties: { command: { type: 'string' } } }
          }
        }]
      })
    });
    assert.equal(completion.status, 200);
    const body = await completion.text();
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(provider.modelsSeen, ['qwen3.8-max-preview', 'qwen3.7-max-no-thinking']);
    assert.match(body, /qwen\/qwen3\.7-max-no-thinking/);
    assert.match(body, /"name":"terminal"/);
  } finally {
    if (previousTimeout === undefined) delete process.env.AGENTPROXY_THINKING_PREVALIDATE_TIMEOUT_MS;
    else process.env.AGENTPROXY_THINKING_PREVALIDATE_TIMEOUT_MS = previousTimeout;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await restoreAgentProxyHome();
  }
});

let previousAgentProxyHome: string | undefined;
let tempAgentProxyHome: string | null = null;

async function useTempAgentProxyHome(): Promise<string> {
  previousAgentProxyHome = process.env.AGENTPROXY_HOME;
  tempAgentProxyHome = await mkdtemp(path.join(os.tmpdir(), 'agentproxy-test-'));
  process.env.AGENTPROXY_HOME = tempAgentProxyHome;
  return tempAgentProxyHome;
}

async function restoreAgentProxyHome(): Promise<void> {
  if (previousAgentProxyHome === undefined) delete process.env.AGENTPROXY_HOME;
  else process.env.AGENTPROXY_HOME = previousAgentProxyHome;
  if (tempAgentProxyHome) await rm(tempAgentProxyHome, { recursive: true, force: true });
  tempAgentProxyHome = null;
}

function waitForAbortOrDelay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
