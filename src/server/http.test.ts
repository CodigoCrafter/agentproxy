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
