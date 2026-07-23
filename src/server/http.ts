import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AgentProxyConfig } from '../config.js';
import { buildHermesPrompt } from '../context/hermes.js';
import {
  buildRequestTelemetry,
  recordRequestEnd,
  recordRequestError,
  recordRequestStart,
  recordStreamError,
  type RequestTelemetry
} from '../diagnostics/telemetry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { StreamingToolParser } from '../tools/parser.js';
import type { ChatCompletionRequest, ProviderStreamEvent, Usage } from '../types.js';

const STABLE_QWEN_TOOL_FALLBACK = 'qwen/qwen3.7-max-no-thinking';
const DEFAULT_THINKING_PREVALIDATION_TIMEOUT_MS = 45_000;

export function createApiServer(
  config: AgentProxyConfig,
  registry: ProviderRegistry,
  shutdown: () => void
) {
  return createServer(async (request, response) => {
    try {
      await route(request, response, config, registry, shutdown);
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      json(response, statusForError(error), { error: { message: (error as Error).message, type: 'agentproxy_error' } });
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentProxyConfig,
  registry: ProviderRegistry,
  shutdown: () => void
): Promise<void> {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok', profile: config.profile, pid: process.pid });
    return;
  }

  requireAuth(request, config.apiKey);

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const models = await registry.listModels();
    json(response, 200, {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: model.ownedBy,
        capabilities: model.capabilities
      }))
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson<ChatCompletionRequest>(request, 4 * 1024 * 1024);
    validateChatRequest(body);
    await chatCompletion(request, response, body, config, registry);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/_internal/shutdown') {
    json(response, 200, { status: 'stopping' });
    setTimeout(shutdown, 25).unref();
    return;
  }

  json(response, 404, { error: { message: 'Route not found' } });
}

async function chatCompletion(
  incoming: IncomingMessage,
  response: ServerResponse,
  body: ChatCompletionRequest,
  config: AgentProxyConfig,
  registry: ProviderRegistry
): Promise<void> {
  const modelId = body.model || config.defaultModel;
  const { provider, model } = registry.resolve(modelId);
  const prompt = buildHermesPrompt(body, config.context);
  const sessionId = deriveSessionId(incoming, body);
  const requestId = `apxreq-${randomUUID()}`;
  const telemetry = buildRequestTelemetry(requestId, modelId, model, sessionId, body, prompt);
  const startedAt = performance.now();
  await recordRequestStart(telemetry);
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) controller.abort(new Error('Client disconnected'));
  });

  try {
    const attempt = await prepareProviderEvents({
      provider,
      model,
      modelId,
      prompt: prompt.prompt,
      requestId,
      sessionId,
      body,
      config,
      signal: controller.signal
    });
    if (body.stream) {
      const events = await primeStream(attempt.events);
      await streamResponse(response, events, attempt.modelId, body, config, telemetry, startedAt);
    } else {
      await jsonResponse(response, attempt.events, attempt.modelId, prompt.prompt, body, config.context.exposeReasoning, telemetry, startedAt);
    }
  } catch (error) {
    const fallbackModelId = fallbackModelFor(config, modelId, model, provider.id, body, error);
    if (!fallbackModelId || response.headersSent) {
      await recordRequestError(telemetry, elapsedMs(startedAt), error);
      throw error;
    }
    process.stderr.write(`[AgentProxy] retrying ${modelId} with fallback ${fallbackModelId}: ${(error as Error).message}\n`);
    try {
      const fallback = registry.resolve(fallbackModelId);
      const attempt = await prepareProviderEvents({
        provider: fallback.provider,
        model: fallback.model,
        modelId: fallbackModelId,
        prompt: prompt.prompt,
        requestId,
        sessionId,
        body,
        config,
        signal: controller.signal
      });
      if (body.stream) {
        const events = await primeStream(attempt.events);
        await streamResponse(response, events, attempt.modelId, body, config, telemetry, startedAt);
      } else {
        await jsonResponse(response, attempt.events, attempt.modelId, prompt.prompt, body, config.context.exposeReasoning, telemetry, startedAt);
      }
    } catch (fallbackError) {
      await recordRequestError(telemetry, elapsedMs(startedAt), fallbackError);
      throw fallbackError;
    }
  }
}

async function prepareProviderEvents(options: {
  provider: ReturnType<ProviderRegistry['resolve']>['provider'];
  model: string;
  modelId: string;
  prompt: string;
  requestId: string;
  sessionId: string;
  body: ChatCompletionRequest;
  config: AgentProxyConfig;
  signal: AbortSignal;
}): Promise<{ modelId: string; events: AsyncIterable<ProviderStreamEvent> }> {
  const prevalidate = shouldPrevalidateToolStream(options.provider.id, options.model, options.body);
  const linkedAbort = prevalidate ? createLinkedAbortController(options.signal) : null;
  const events = options.provider.stream({
    model: options.model,
    prompt: options.prompt,
    requestId: options.requestId,
    sessionId: options.sessionId,
    thinking: !options.model.endsWith('-no-thinking'),
    signal: linkedAbort?.controller.signal || options.signal,
    idleTimeoutMs: options.provider.idleTimeoutMs
  });

  if (!prevalidate) {
    return { modelId: options.modelId, events };
  }

  const prevalidationAbort = linkedAbort;
  if (!prevalidationAbort) throw new Error('Missing prevalidation abort controller.');

  try {
    const collected = await collectProviderEvents(
      events,
      thinkingPrevalidationTimeoutMs(),
      prevalidationAbort.controller
    );
    validateToolStream(collected, options.body);
    return { modelId: options.modelId, events: iterableFromArray(collected) };
  } finally {
    prevalidationAbort.cleanup();
  }
}

function shouldPrevalidateToolStream(providerId: string, model: string, body: ChatCompletionRequest): boolean {
  return providerId === 'qwen' && Boolean(body.tools?.length) && !model.endsWith('-no-thinking');
}

async function collectProviderEvents(
  events: AsyncIterable<ProviderStreamEvent>,
  timeoutMs: number,
  controller: AbortController
): Promise<ProviderStreamEvent[]> {
  const collected: ProviderStreamEvent[] = [];
  const timeoutError = Object.assign(
    new Error(`Qwen thinking prevalidation exceeded ${timeoutMs}ms; retry with a no-thinking model.`),
    { statusCode: 502 }
  );
  let timer: NodeJS.Timeout | undefined;
  const collection = (async () => {
    for await (const event of events) collected.push(event);
    return collected;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([collection, timeout]);
  } catch (error) {
    collection.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* iterableFromArray<T>(values: T[]): AsyncIterable<T> {
  yield* values;
}

function validateToolStream(events: ProviderStreamEvent[], body: ChatCompletionRequest): void {
  const parser = new StreamingToolParser(undefined, allowedToolNames(body));
  let text = '';
  for (const event of events) {
    if (event.type !== 'text') continue;
    text += event.text;
    const parsed = parser.feed(event.text);
    rejectMalformedToolCall(parsed.malformedToolCall);
  }
  const remaining = parser.flush();
  rejectMalformedToolCall(remaining.malformedToolCall);
  text += remaining.text;
  if (parser.getToolCallCount() === 0 && looksLikeToolAvailabilityHallucination(text, body)) {
    throw Object.assign(
      new Error('Upstream model claimed an available tool does not exist; retry with a no-thinking model.'),
      { statusCode: 502 }
    );
  }
}

function fallbackModelFor(
  config: AgentProxyConfig,
  requestedModelId: string,
  providerModel: string,
  providerId: string,
  body: ChatCompletionRequest,
  error: unknown
): string | null {
  if (providerId !== 'qwen' || !body.tools?.length || providerModel.endsWith('-no-thinking')) return null;
  if (!isRecoverableThinkingFailure(error)) return null;
  const fallback = requestedModelId !== STABLE_QWEN_TOOL_FALLBACK
    ? STABLE_QWEN_TOOL_FALLBACK
    : noThinkingModelId(config.defaultModel || requestedModelId);
  return fallback !== requestedModelId ? fallback : null;
}

function noThinkingModelId(modelId: string): string {
  return modelId.endsWith('-no-thinking') ? modelId : `${modelId}-no-thinking`;
}

function isRecoverableThinkingFailure(error: unknown): boolean {
  const message = (error as Error | undefined)?.message || '';
  const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
  return statusCode === 500 || statusCode === 502 || /tool call|timeout|empty response|no final answer|chat is in progress|has been closed/i.test(message);
}

function looksLikeToolAvailabilityHallucination(text: string, body: ChatCompletionRequest): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const unavailablePattern = /tool .{1,80}(?:does not exist|does not exists|not available|not found)|ferramenta .{1,80}(?:nao existe|indisponivel)|schema .{1,120}(?:only includes|so inclui)/i;
  if (!unavailablePattern.test(normalized)) return false;
  return (body.tools || []).some((tool) => normalized.includes(tool.function.name.toLowerCase()));
}

function thinkingPrevalidationTimeoutMs(): number {
  const value = Number(process.env.AGENTPROXY_THINKING_PREVALIDATE_TIMEOUT_MS || '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_THINKING_PREVALIDATION_TIMEOUT_MS;
}

function createLinkedAbortController(signal: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', abort)
  };
}

async function primeStream<T>(events: AsyncIterable<T>): Promise<AsyncIterable<T>> {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  return {
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
  };
}

async function streamResponse(
  response: ServerResponse,
  events: AsyncIterable<import('../types.js').ProviderStreamEvent>,
  model: string,
  body: ChatCompletionRequest,
  config: AgentProxyConfig,
  telemetry: RequestTelemetry,
  startedAt: number
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const parser = new StreamingToolParser(undefined, allowedToolNames(body));
  let emittedTools = 0;
  let inputTokens = estimateTokens(body.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n'));
  let outputTokens = 0;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const send = (choices: unknown[], usage?: Usage) => {
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...(usage ? { usage } : {}) })}\n\n`);
  };
  const choice = (delta: unknown, finishReason: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finishReason });
  send([choice({ role: 'assistant', content: '' })]);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  heartbeat.unref();

  try {
    for await (const event of events) {
      if (event.type === 'usage') {
        inputTokens = event.inputTokens || inputTokens;
        outputTokens = event.outputTokens || outputTokens;
      } else if (event.type === 'reasoning' && config.context.exposeReasoning) {
        send([choice({ reasoning_content: event.text })]);
      } else if (event.type === 'text') {
        outputTokens += estimateTokens(event.text);
        const parsed = parser.feed(event.text);
        rejectMalformedToolCall(parsed.malformedToolCall);
        if (parsed.text) send([choice({ content: parsed.text })]);
        for (const call of parsed.toolCalls) {
          send([choice({
            tool_calls: [{
              index: emittedTools++,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }]
          })]);
        }
      }
    }
    const remaining = parser.flush();
    rejectMalformedToolCall(remaining.malformedToolCall);
    if (remaining.text) send([choice({ content: remaining.text })]);
    for (const call of remaining.toolCalls) {
      send([choice({
        tool_calls: [{
          index: emittedTools++,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }]
      })]);
    }
    const usage = makeUsage(inputTokens, outputTokens);
    send([choice({}, parser.getToolCallCount() ? 'tool_calls' : 'stop')], body.stream_options?.include_usage ? undefined : usage);
    if (body.stream_options?.include_usage) send([], usage);
    response.write('data: [DONE]\n\n');
    await recordRequestEnd(telemetry, elapsedMs(startedAt), emittedTools, inputTokens, outputTokens);
  } catch (error) {
    const message = (error as Error).message || 'Unknown provider streaming error';
    process.stderr.write(`[AgentProxy] streaming error model=${model}: ${message}\n`);
    await recordStreamError(telemetry, elapsedMs(startedAt), emittedTools, error);
    response.write(`data: ${JSON.stringify({ error: { message, type: 'agentproxy_upstream_error' } })}\n\n`);
    response.write('data: [DONE]\n\n');
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

async function jsonResponse(
  response: ServerResponse,
  events: AsyncIterable<import('../types.js').ProviderStreamEvent>,
  model: string,
  prompt: string,
  body: ChatCompletionRequest,
  exposeReasoning: boolean,
  telemetry: RequestTelemetry,
  startedAt: number
): Promise<void> {
  const parser = new StreamingToolParser(undefined, allowedToolNames(body));
  let content = '';
  let reasoning = '';
  let inputTokens = estimateTokens(prompt);
  let outputTokens = 0;
  const toolCalls: Array<Record<string, unknown>> = [];

  for await (const event of events) {
    if (event.type === 'text') {
      outputTokens += estimateTokens(event.text);
      const parsed = parser.feed(event.text);
      rejectMalformedToolCall(parsed.malformedToolCall);
      content += parsed.text;
      for (const call of parsed.toolCalls) toolCalls.push(openAiToolCall(call, toolCalls.length));
    } else if (event.type === 'reasoning') reasoning += event.text;
    else if (event.type === 'usage') {
      inputTokens = event.inputTokens || inputTokens;
      outputTokens = event.outputTokens || outputTokens;
    }
  }
  const remaining = parser.flush();
  rejectMalformedToolCall(remaining.malformedToolCall);
  content += remaining.text;
  for (const call of remaining.toolCalls) toolCalls.push(openAiToolCall(call, toolCalls.length));

  const message: Record<string, unknown> = { role: 'assistant', content: toolCalls.length ? null : content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoning && exposeReasoning) message.reasoning_content = reasoning;
  const usage = makeUsage(inputTokens, outputTokens);
  await recordRequestEnd(telemetry, elapsedMs(startedAt), toolCalls.length, inputTokens, outputTokens);
  json(response, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage
  });
}

function openAiToolCall(call: { id: string; name: string; arguments: Record<string, unknown> }, index: number) {
  return { index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
}

function allowedToolNames(body: ChatCompletionRequest): Set<string> | undefined {
  if (!body.tools?.length) return undefined;
  return new Set(body.tools.map((tool) => tool.function.name));
}

function rejectMalformedToolCall(raw: string | undefined): void {
  if (!raw) return;
  throw Object.assign(
    new Error('Upstream model returned a truncated tool call; retry the request.'),
    { statusCode: 502 }
  );
}

function deriveSessionId(request: IncomingMessage, body: ChatCompletionRequest): string {
  const header = request.headers['x-agentproxy-session'] || request.headers['x-session-id'];
  if (typeof header === 'string' && header) return header.slice(0, 200);
  if (body.session_id) return body.session_id.slice(0, 200);
  const metadataId = body.metadata?.session_id;
  if (typeof metadataId === 'string') return metadataId.slice(0, 200);
  if (body.user) return body.user.slice(0, 200);
  return '__default__';
}

function validateChatRequest(body: ChatCompletionRequest): void {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw Object.assign(new Error('messages must be a non-empty array'), { statusCode: 400 });
  }
}

function requireAuth(request: IncomingMessage, apiKey: string): void {
  if (request.headers.authorization !== `Bearer ${apiKey}`) {
    throw Object.assign(new Error('Invalid AgentProxy API key'), { statusCode: 401 });
  }
}

async function readJson<T>(request: IncomingMessage, limit: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeUsage(input: number, output: number): Usage {
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const value = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(value) });
  response.end(value);
}

function statusForError(error: unknown): number {
  const status = (error as { statusCode?: number }).statusCode;
  return status && status >= 400 && status <= 599 ? status : 500;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
