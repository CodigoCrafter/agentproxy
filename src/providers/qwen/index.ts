import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths, type AgentProxyConfig } from '../../config.js';
import type { ProviderStreamEvent } from '../../types.js';
import type { AuthenticationOptions, AuthStatus, ModelInfo, ProviderAdapter, ProviderRequest } from '../types.js';
import { QwenBrowserAuth } from './auth.js';

interface QwenChunk {
  success?: boolean;
  message?: string;
  data?: { code?: string; details?: string };
  response_id?: string;
  choices?: Array<{
    delta?: {
      phase?: string;
      content?: string;
      extra?: { summary_thought?: { content?: string[] } };
    };
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const NON_RETRYABLE_QWEN_THROTTLE_STATUS = 400;
const QWEN_THROTTLE_MESSAGE = 'Qwen web temporarily throttled this automation session. Reduce parallel subagents or wait before retrying.';

export class QwenProvider implements ProviderAdapter {
  readonly id = 'qwen';
  private readonly accounts: QwenAccountState[];
  private modelCache: { expiresAt: number; models: ModelInfo[] } | null = null;
  private readonly retryCooldownMs = 2_000;

  constructor(private readonly config: AgentProxyConfig) {
    this.accounts = this.configuredAccounts().map((account) => ({
      id: account.id,
      label: account.label || account.id,
      auth: new QwenBrowserAuth(config, account.id),
      requestGate: new QwenRequestGate(config.providers.qwen.maxConcurrentRequests),
      rateLimitedUntil: 0,
      rateLimitMessage: '',
      authUnavailableUntil: 0,
      lastUsedAt: 0,
      successCount: 0
    }));
  }

  get idleTimeoutMs(): number {
    return this.config.providers.qwen.idleTimeoutMs;
  }

  authenticate(options?: AuthenticationOptions): Promise<void> {
    return this.accountForLogin(options?.accountId).auth.authenticate(options?.force);
  }

  async authStatus(): Promise<AuthStatus> {
    const statuses = await Promise.all(this.accounts.map(async (account) => ({
      account,
      status: await account.auth.status()
    })));
    const authenticated = statuses.filter((entry) => entry.status.authenticated);
    if (authenticated.length > 0) {
      return {
        authenticated: true,
        detail: authenticated.map((entry) => `${entry.account.id}: ok`).join(', ')
      };
    }
    return {
      authenticated: false,
      detail: `Nenhuma conta Qwen logada. Execute: proxy login qwen ${this.accounts[0]?.id || 'main'}`
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;
    const account = await this.firstAuthenticatedAccount();
    const headers = await account.auth.getBasicHeaders();
    const response = await fetch('https://chat.qwen.ai/api/models', {
      headers: this.requestHeaders(headers, 'https://chat.qwen.ai/')
    });
    if (!response.ok) throw new Error(`Qwen models request failed: HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const baseModels = (body.data || []).map((model) => this.modelInfo(model.id, model.owned_by || 'qwen'));
    const models = baseModels.flatMap((model) => [
      model,
      { ...model, id: `${model.id}-no-thinking`, capabilities: { ...model.capabilities, reasoning: false } }
    ]);
    this.modelCache = { expiresAt: Date.now() + 60 * 60 * 1000, models };
    return models;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const model = request.model.replace(/-no-thinking$/, '');
    const attempted = new Set<string>();
    const errors: Error[] = [];

    while (attempted.size < this.accounts.length) {
      const account = this.selectAccount(attempted);
      attempted.add(account.id);
      try {
        yield* this.streamWithAccount(account, request, model);
        return;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        errors.push(normalized);
        if (isQwenRateLimitError(error)) {
          this.openRateLimitCircuit(account, error);
          continue;
        }
        if (this.isAuthUnavailableError(error)) {
          this.markAuthUnavailable(account, error);
          continue;
        }
        throw error;
      }
    }

    throw this.noAvailableAccountError(errors);
  }

  close(): Promise<void> {
    return Promise.allSettled(this.accounts.map((account) => account.auth.close())).then(() => undefined);
  }

  private async *streamWithAccount(
    account: QwenAccountState,
    request: ProviderRequest,
    model: string
  ): AsyncIterable<ProviderStreamEvent> {
    this.assertAccountAvailable(account);
    if (!account.requestGate.hasCapacity) {
      throw Object.assign(
        new Error(`Qwen account "${account.id}" is busy (${account.requestGate.activeCount}/${this.config.providers.qwen.maxConcurrentRequests} active requests). Try again after a current request finishes or log another Qwen account.`),
        { statusCode: NON_RETRYABLE_QWEN_THROTTLE_STATUS }
      );
    }
    const releaseRequestSlot = await account.requestGate.acquire(request.signal, this.config.providers.qwen.queueTimeoutMs);
    const upstreamSessionId = this.upstreamSessionId(account, request);
    let releaseSession: (() => void) | undefined;
    let shouldInvalidateSession = false;
    let streamError: unknown;
    try {
      this.assertAccountAvailable(account);
      const { session, release } = await account.auth.acquireSession(upstreamSessionId, model);
      releaseSession = release;
      account.lastUsedAt = Date.now();
      const timestamp = Math.floor(Date.now() / 1000);
      const payload = {
        stream: true,
        version: '2.1',
        incremental_output: true,
        chat_id: session.chatId,
        chat_mode: 'normal',
        model,
        parent_id: null,
        messages: [{
          fid: randomUUID(),
          parentId: null,
          childrenIds: [],
          role: 'user',
          content: request.prompt,
          user_action: 'chat',
          files: [],
          timestamp,
          models: [model],
          chat_type: 't2t',
          feature_config: {
            thinking_enabled: request.thinking,
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: false,
            thinking_mode: 'Thinking',
            thinking_format: 'summary',
            auto_search: false
          },
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null
        }],
        timestamp: timestamp + 1
      };

      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener('abort', abort, { once: true });
      const totalTimer = setTimeout(() => controller.abort(new Error('Qwen request timeout')), this.config.providers.qwen.requestTimeoutMs);

      try {
        const response = await fetch(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${session.chatId}`, {
          method: 'POST',
          headers: this.requestHeaders(session.headers, `https://chat.qwen.ai/c/${session.chatId}`),
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Qwen request failed: HTTP ${response.status} ${detail.slice(0, 500)}`);
        }
        yield* this.readQwenStream(response.body, request.idleTimeoutMs, controller);
        account.successCount++;
      } catch (error) {
        shouldInvalidateSession = true;
        streamError = error;
        throw error;
      } finally {
        clearTimeout(totalTimer);
        request.signal.removeEventListener('abort', abort);
      }
    } catch (error) {
      throw error;
    } finally {
      releaseSession?.();
      if (shouldInvalidateSession) {
        await account.auth.invalidateSession(upstreamSessionId);
        if (this.needsRetryCooldown(streamError)) await delay(this.retryCooldownMs);
      } else {
        await account.auth.invalidateSession(upstreamSessionId);
      }
      releaseRequestSlot();
    }
  }

  private async *readQwenStream(
    stream: ReadableStream<Uint8Array>,
    idleTimeoutMs: number,
    controller: AbortController
  ): AsyncIterable<ProviderStreamEvent> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answerContent = '';
    let targetResponseId: string | null = null;
    let thoughtCount = 0;
    let debugSample = '';
    let receivedReasoning = false;
    let receivedAnswer = false;

    try {
      while (true) {
        const result = await this.readWithIdleTimeout(reader, idleTimeoutMs, controller);
        if (result.done) break;
        const decoded = decoder.decode(result.value, { stream: true });
        buffer += decoded;
        if (process.env.AGENTPROXY_DEBUG === '1' && debugSample.length < 64_000) {
          debugSample += decoded.slice(0, 64_000 - debugSample.length);
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let chunk: QwenChunk;
          try { chunk = JSON.parse(raw) as QwenChunk; } catch { continue; }

          if (chunk.success === false) {
            throw this.upstreamError(chunk);
          }

          const delta = chunk.choices?.[0]?.delta;
          if (chunk.response_id && delta) {
            if (!targetResponseId) targetResponseId = chunk.response_id;
            if (chunk.response_id !== targetResponseId) continue;
          }

          if (chunk.usage) {
            yield { type: 'usage', inputTokens: chunk.usage.input_tokens, outputTokens: chunk.usage.output_tokens };
          }
          if (!delta) continue;
          if (delta.phase === 'thinking_summary') {
            const thoughts = delta.extra?.summary_thought?.content || [];
            if (thoughts.length > thoughtCount) {
              const text = thoughts.slice(thoughtCount).join('\n');
              thoughtCount = thoughts.length;
              if (text) {
                receivedReasoning = true;
                yield { type: 'reasoning', text };
              }
            }
          } else if ((delta.phase === 'answer' || !delta.phase) && typeof delta.content === 'string') {
            if (delta.content && delta.content !== 'FINISHED') {
              answerContent = reconcileQwenContent(answerContent, delta.content);
              receivedAnswer = true;
            }
          }
        }
      }
      const trailing = buffer.trim().replace(/^data:\s*/, '');
      if (trailing) {
        try {
          const value = JSON.parse(trailing) as {
            success?: boolean;
            data?: { code?: string; details?: string };
            message?: string;
          };
          if (value.success === false) {
            throw this.upstreamError(value);
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            // Ignore a final partial SSE fragment; complete events were handled above.
          } else {
            throw error;
          }
        }
      }
      if (!receivedReasoning && !receivedAnswer) {
        throw new Error('Qwen returned an empty response. The web session may be rate-limited or stale.');
      }
      if (!answerContent) {
        throw new Error('Qwen returned reasoning but no final answer. Retry with a no-thinking model.');
      }
      if (answerContent) yield { type: 'text', text: answerContent };
      yield { type: 'done' };
    } finally {
      if (process.env.AGENTPROXY_DEBUG === '1' && debugSample) {
        await writeFile(path.join(getPaths().logs, 'qwen-upstream-sample.log'), debugSample, 'utf8').catch(() => undefined);
      }
      await reader.cancel().catch(() => undefined);
    }
  }

  private readWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    controller: AbortController
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort(new Error(`Qwen stream idle for ${timeoutMs}ms`));
        reject(new Error(`Qwen stream idle timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      reader.read().then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); }
      );
    });
  }

  private upstreamError(value: { data?: { code?: string; details?: string }; message?: string }): Error {
    const code = value.data?.code || 'Unknown';
    const detail = value.data?.details || value.message || 'request failed';
    if (code === 'RateLimited') {
      return Object.assign(
        new Error(`${QWEN_THROTTLE_MESSAGE} Upstream code: ${code}.`),
        { statusCode: NON_RETRYABLE_QWEN_THROTTLE_STATUS, upstreamStatusCode: 429, upstreamDetail: detail }
      );
    }
    const statusCode = code === 'Bad_Request' ? 400 : 502;
    return Object.assign(new Error(`Qwen upstream error: ${code}: ${detail}`), { statusCode });
  }

  private needsRetryCooldown(error: unknown): boolean {
    const message = (error as Error | undefined)?.message || '';
    return /timeout|chat is in progress|has been closed/i.test(message);
  }

  private upstreamSessionId(account: QwenAccountState, request: ProviderRequest): string {
    return `${account.id}:${request.sessionId || '__default__'}:${request.requestId}`;
  }

  private assertAccountAvailable(account: QwenAccountState): void {
    const remainingMs = Math.max(account.rateLimitedUntil, account.authUnavailableUntil) - Date.now();
    if (remainingMs <= 0) return;
    throw Object.assign(
      new Error(`${account.rateLimitMessage || `Qwen account "${account.id}" is temporarily unavailable.`} Retry after about ${Math.ceil(remainingMs / 60_000)} minute(s).`),
      { statusCode: NON_RETRYABLE_QWEN_THROTTLE_STATUS, upstreamStatusCode: 429 }
    );
  }

  private openRateLimitCircuit(account: QwenAccountState, _error: unknown): void {
    const cooldownMs = Math.max(1_000, this.config.providers.qwen.rateLimitCooldownMs);
    account.rateLimitedUntil = Math.max(account.rateLimitedUntil, Date.now() + cooldownMs);
    account.rateLimitMessage = `${QWEN_THROTTLE_MESSAGE} Account "${account.id}" is in cooldown.`;
  }

  private markAuthUnavailable(account: QwenAccountState, error: unknown): void {
    account.authUnavailableUntil = Date.now() + 60_000;
    account.rateLimitMessage = (error as Error | undefined)?.message || `Qwen account "${account.id}" is unavailable.`;
  }

  private isAuthUnavailableError(error: unknown): boolean {
    const message = (error as Error | undefined)?.message || '';
    return /sessao do qwen expirada|execute: proxy login qwen|login|auth/i.test(message);
  }

  private selectAccount(attempted: Set<string>): QwenAccountState {
    const now = Date.now();
    const available = this.accounts
      .filter((account) => !attempted.has(account.id))
      .filter((account) => account.rateLimitedUntil <= now && account.authUnavailableUntil <= now)
      .filter((account) => account.requestGate.hasCapacity)
      .sort((a, b) => a.requestGate.activeCount - b.requestGate.activeCount || b.successCount - a.successCount || a.lastUsedAt - b.lastUsedAt);
    if (available[0]) return available[0];

    const remaining = this.accounts.filter((account) => !attempted.has(account.id));
    if (remaining[0]) {
      return remaining.sort((a, b) => Math.max(a.rateLimitedUntil, a.authUnavailableUntil) - Math.max(b.rateLimitedUntil, b.authUnavailableUntil))[0];
    }
    throw new Error('No Qwen accounts configured.');
  }

  private noAvailableAccountError(errors: Error[]): Error {
    const nextAt = Math.min(...this.accounts.map((account) => Math.max(account.rateLimitedUntil, account.authUnavailableUntil)).filter((value) => value > Date.now()));
    const wait = Number.isFinite(nextAt) ? ` Retry after about ${Math.max(1, Math.ceil((nextAt - Date.now()) / 60_000))} minute(s).` : '';
    const details = errors.map((error) => error.message).filter(Boolean).slice(-3).join(' | ');
    return Object.assign(
      new Error(`No Qwen account is currently available.${wait}${details ? ` Last errors: ${details}` : ''}`),
      { statusCode: NON_RETRYABLE_QWEN_THROTTLE_STATUS, upstreamStatusCode: 429 }
    );
  }

  private configuredAccounts() {
    return this.config.providers.qwen.accounts.filter((account) => account.enabled !== false);
  }

  private accountForLogin(accountId = 'main'): QwenAccountState {
    const account = this.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new Error(`Conta Qwen nao configurada: ${accountId}`);
    return account;
  }

  private async firstAuthenticatedAccount(): Promise<QwenAccountState> {
    for (const account of this.accounts) {
      const status = await account.auth.status();
      if (status.authenticated) return account;
    }
    throw new Error(`Nenhuma conta Qwen logada. Execute: proxy login qwen ${this.accounts[0]?.id || 'main'}`);
  }

  private requestHeaders(source: Record<string, string>, referer: string): Record<string, string> {
    return {
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
      cookie: source.cookie,
      origin: 'https://chat.qwen.ai',
      referer,
      'user-agent': source['user-agent'],
      'x-request-id': randomUUID(),
      'bx-ua': source['bx-ua'],
      'bx-umidtoken': source['bx-umidtoken'] || '',
      'bx-v': source['bx-v'] || '2.5.36',
      timezone: new Date().toString().split(' (')[0]
    };
  }

  private modelInfo(id: string, ownedBy: string): ModelInfo {
    return {
      id: `qwen/${id}`,
      provider: 'qwen',
      ownedBy,
      capabilities: { streaming: true, tools: true, reasoning: true, vision: false }
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QwenAccountState {
  id: string;
  label: string;
  auth: QwenBrowserAuth;
  requestGate: QwenRequestGate;
  rateLimitedUntil: number;
  rateLimitMessage: string;
  authUnavailableUntil: number;
  lastUsedAt: number;
  successCount: number;
}

export class QwenRequestGate {
  private active = 0;
  private readonly queue: QwenQueueEntry[] = [];

  constructor(private readonly maxConcurrentRequests: number) {}

  get activeCount(): number {
    return this.active;
  }

  get hasCapacity(): boolean {
    return this.maxConcurrentRequests <= 0 || this.active < this.maxConcurrentRequests;
  }

  acquire(signal: AbortSignal, timeoutMs: number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.maxConcurrentRequests <= 0 || this.active < this.maxConcurrentRequests) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      let entry: QwenQueueEntry;
      entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeQueued(entry);
          reject(Object.assign(new Error(`Qwen concurrency queue exceeded ${timeoutMs}ms.`), { statusCode: 503 }));
        }, timeoutMs),
        abort: () => {
          this.removeQueued(entry);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted while waiting for Qwen concurrency slot.'));
        },
        signal
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    clearTimeout(next.timer);
    next.signal.removeEventListener('abort', next.abort);
    next.resolve(() => this.release());
  }

  private removeQueued(entry: QwenQueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
  }
}

interface QwenQueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort: () => void;
  signal: AbortSignal;
}

export function isQwenRateLimitError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
  const upstreamStatusCode = (error as { upstreamStatusCode?: number } | undefined)?.upstreamStatusCode;
  const message = (error as Error | undefined)?.message || '';
  return statusCode === 429 || upstreamStatusCode === 429 || /RateLimited|upper limit|rate limit/i.test(message);
}

export function reconcileQwenContent(previous: string, current: string): string {
  if (!current) return previous;
  if (!previous) return current;
  if (current === previous || previous.endsWith(current)) return previous;
  if (current.startsWith(previous)) return current;
  if (previous.startsWith(current)) return previous;

  const limit = Math.min(previous.length, current.length);
  let commonPrefix = 0;
  while (commonPrefix < limit && previous[commonPrefix] === current[commonPrefix]) commonPrefix += 1;

  // Qwen occasionally replaces a cumulative snapshot after revising its tail.
  // Keep the newest snapshot instead of appending a second copy of its prefix.
  if (commonPrefix >= 16 && commonPrefix / limit >= 0.5) return current;

  return previous + current;
}
