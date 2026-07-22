import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { getPaths } from '../config.js';
import type { ChatCompletionRequest } from '../types.js';
import type { PromptBuildResult } from '../context/hermes.js';

export interface RequestTelemetry {
  requestId: string;
  model: string;
  providerModel: string;
  stream: boolean;
  sessionHash: string;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  roleCounts: Record<string, number>;
  promptChars: number;
  promptTokensEstimate: number;
  truncatedCharacters: number;
  includedMessages: number;
  toolResultChars: number;
  largestToolResultChars: number;
}

type TelemetryEvent =
  | ({ type: 'request_start' } & RequestTelemetry)
  | ({ type: 'request_end'; durationMs: number; emittedToolCalls: number; inputTokens: number; outputTokens: number } & RequestTelemetry)
  | ({ type: 'request_error'; durationMs: number; error: { message: string; statusCode?: number } } & RequestTelemetry)
  | ({ type: 'stream_error'; durationMs: number; emittedToolCalls: number; error: { message: string; statusCode?: number } } & RequestTelemetry);

export function buildRequestTelemetry(
  requestId: string,
  model: string,
  providerModel: string,
  sessionId: string,
  body: ChatCompletionRequest,
  prompt: PromptBuildResult
): RequestTelemetry {
  const roleCounts: Record<string, number> = {};
  let toolResultChars = 0;
  let largestToolResultChars = 0;

  for (const message of body.messages) {
    roleCounts[message.role] = (roleCounts[message.role] || 0) + 1;
    if (message.role === 'tool' || message.role === 'function') {
      const length = contentLength(message.content);
      toolResultChars += length;
      largestToolResultChars = Math.max(largestToolResultChars, length);
    }
  }

  return {
    requestId,
    model,
    providerModel,
    stream: Boolean(body.stream),
    sessionHash: hashSession(sessionId),
    messageCount: body.messages.length,
    toolCount: body.tools?.length || 0,
    toolNames: (body.tools || []).map((tool) => tool.function.name).slice(0, 100),
    roleCounts,
    promptChars: prompt.prompt.length,
    promptTokensEstimate: Math.ceil(prompt.prompt.length / 4),
    truncatedCharacters: prompt.truncatedCharacters,
    includedMessages: prompt.includedMessages,
    toolResultChars,
    largestToolResultChars
  };
}

export async function recordRequestStart(telemetry: RequestTelemetry): Promise<void> {
  await appendTelemetry({ type: 'request_start', ...telemetry });
}

export async function recordRequestEnd(
  telemetry: RequestTelemetry,
  durationMs: number,
  emittedToolCalls: number,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await appendTelemetry({ type: 'request_end', ...telemetry, durationMs, emittedToolCalls, inputTokens, outputTokens });
}

export async function recordRequestError(telemetry: RequestTelemetry, durationMs: number, error: unknown): Promise<void> {
  await appendTelemetry({ type: 'request_error', ...telemetry, durationMs, error: sanitizeError(error) });
}

export async function recordStreamError(
  telemetry: RequestTelemetry,
  durationMs: number,
  emittedToolCalls: number,
  error: unknown
): Promise<void> {
  await appendTelemetry({ type: 'stream_error', ...telemetry, durationMs, emittedToolCalls, error: sanitizeError(error) });
}

async function appendTelemetry(event: TelemetryEvent): Promise<void> {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
  const paths = getPaths();
  await mkdir(paths.logs, { recursive: true }).catch(() => undefined);
  await appendFile(paths.telemetry, line, 'utf8').catch(() => undefined);
}

function contentLength(content: ChatCompletionRequest['messages'][number]['content']): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, item) => total + (item.text?.length || 0), 0);
}

function hashSession(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function sanitizeError(error: unknown): { message: string; statusCode?: number } {
  const value = error as { message?: string; statusCode?: number };
  return {
    message: value?.message || 'Unknown error',
    ...(value?.statusCode ? { statusCode: value.statusCode } : {})
  };
}
