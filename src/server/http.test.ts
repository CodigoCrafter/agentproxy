import assert from 'node:assert/strict';
import { once } from 'node:events';
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

test('HTTP API authenticates requests and emits OpenAI tool calls', async () => {
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP streaming reports failures before output as an HTTP error', async () => {
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
  }
});


test('HTTP streaming reports failures after output as an SSE error', async () => {
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
