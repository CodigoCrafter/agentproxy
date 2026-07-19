import type { AgentProxyConfig } from '../config.js';
import type { ChatCompletionRequest, ChatMessage, FunctionTool } from '../types.js';

export interface PromptBuildResult {
  prompt: string;
  originalMessages: number;
  includedMessages: number;
  truncatedCharacters: number;
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => item.text || '').filter(Boolean).join('\n');
}

function compactMiddle(value: string, limit: number, label: string): string {
  if (value.length <= limit) return value;
  const marker = `\n...[AgentProxy compacted ${label}; removed ${value.length - limit} characters]...\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ''}`;
}

function truncateToolResult(value: string, limit: number): string {
  return compactMiddle(value, limit, 'tool output');
}

function formatMessage(message: ChatMessage, toolLimit: number): string {
  let content = contentToText(message.content);
  if (message.role === 'tool' || message.role === 'function') {
    content = truncateToolResult(content, toolLimit);
  }

  if (message.role === 'assistant' && message.tool_calls?.length) {
    const calls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJson(call.function.arguments)
    }));
    content = `${content}${content ? '\n' : ''}[tool_calls] ${JSON.stringify(calls)}`;
  }

  const label: Record<ChatMessage['role'], string> = {
    system: 'System',
    developer: 'Developer',
    user: 'User',
    assistant: 'Assistant',
    tool: `Tool${message.name ? ` ${message.name}` : ''}`,
    function: `Tool${message.name ? ` ${message.name}` : ''}`
  };
  const callId = message.tool_call_id ? ` [call_id=${message.tool_call_id}]` : '';
  return `${label[message.role]}${callId}: ${content}`.trimEnd();
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeParameters(parameters: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 6) return parameters.type ? { type: parameters.type } : {};

  const summary: Record<string, unknown> = {};
  const scalarKeys = [
    'type', 'format', 'const', 'enum', 'default', 'minimum', 'maximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'
  ];
  for (const key of scalarKeys) {
    if (parameters[key] !== undefined) summary[key] = parameters[key];
  }

  if (!summary.type && depth === 0) summary.type = 'object';
  if (Array.isArray(parameters.required)) summary.required = parameters.required;

  if (parameters.properties && typeof parameters.properties === 'object' && !Array.isArray(parameters.properties)) {
    summary.properties = Object.fromEntries(
      Object.entries(parameters.properties as Record<string, unknown>).map(([name, value]) => [
        name,
        value && typeof value === 'object' && !Array.isArray(value)
          ? summarizeParameters(value as Record<string, unknown>, depth + 1)
          : {}
      ])
    );
  }

  if (parameters.items && typeof parameters.items === 'object' && !Array.isArray(parameters.items)) {
    summary.items = summarizeParameters(parameters.items as Record<string, unknown>, depth + 1);
  }

  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(parameters[key])) {
      summary[key] = (parameters[key] as unknown[]).map((value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? summarizeParameters(value as Record<string, unknown>, depth + 1)
          : value
      ));
    }
  }

  if (typeof parameters.additionalProperties === 'boolean') {
    summary.additionalProperties = parameters.additionalProperties;
  } else if (parameters.additionalProperties && typeof parameters.additionalProperties === 'object') {
    summary.additionalProperties = summarizeParameters(
      parameters.additionalProperties as Record<string, unknown>,
      depth + 1
    );
  }

  return summary;
}

function compactTools(
  tools: FunctionTool[] | undefined,
  toolChoice: ChatCompletionRequest['tool_choice'],
  limit: number
): string {
  if (!tools?.length) return '';
  let definitions = tools.map((tool) => ({
    name: tool.function.name,
    description: (tool.function.description || '').slice(0, 240),
    parameters: tool.function.parameters || { type: 'object', properties: {} }
  }));
  const forced = typeof toolChoice === 'object' ? toolChoice.function?.name : undefined;
  const instructions = [
    'When a tool is needed, output only <tool_call>{"name":"tool_name","arguments":{}}</tool_call>. Multiple calls may be consecutive.',
    'Do not explain, quote, markdown-wrap, or imitate tool calls. Plain JSON and [tool_calls] envelopes outside <tool_call> are invalid.',
    'After outputting a tool call, stop and wait for the tool result.',
    forced ? `You must call the tool ${JSON.stringify(forced)} now.` : ''
  ].filter(Boolean).join('\n');
  let block = `Tools: ${JSON.stringify(definitions)}\n${instructions}`;
  if (block.length <= limit) return block;

  definitions = tools.map((tool) => ({
    name: tool.function.name,
    description: (tool.function.description || '').slice(0, 100),
    parameters: summarizeParameters(tool.function.parameters || {})
  }));
  block = `Tools: ${JSON.stringify(definitions)}\n${instructions}`;
  if (block.length <= limit) return block;

  return `Tools available: ${tools.map((tool) => tool.function.name).join(', ')}\n${instructions}`;
}

export function buildHermesPrompt(
  request: ChatCompletionRequest,
  context: AgentProxyConfig['context']
): PromptBuildResult {
  const systemMessages = request.messages.filter((message) => message.role === 'system' || message.role === 'developer');
  const conversation = request.messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .slice(-context.maxHistoryMessages);

  const formattedSystem = systemMessages.map((message) => formatMessage(message, context.maxToolResultChars));
  const formattedConversation = conversation.map((message) => formatMessage(message, context.maxToolResultChars));
  const rawSystem = formattedSystem.join('\n\n');
  const systemBudget = Math.min(context.maxSystemChars, Math.floor(context.maxInputChars * 0.45));
  const compactedSystem = compactMiddle(rawSystem, systemBudget, 'oversized system context');
  const conversationReserve = Math.min(36_000, Math.floor(context.maxInputChars * 0.3));
  const toolBudget = Math.max(2_000, context.maxInputChars - compactedSystem.length - conversationReserve - 4);
  const toolBlock = compactTools(request.tools, request.tool_choice, toolBudget);

  const fixed = [compactedSystem, toolBlock].filter(Boolean);
  const selected: string[] = [];
  let size = fixed.join('\n\n').length;

  for (let index = formattedConversation.length - 1; index >= 0; index -= 1) {
    const next = formattedConversation[index];
    const remaining = context.maxInputChars - size - 2;
    if (remaining <= 0) break;
    if (next.length > remaining) {
      if (selected.length === 0) selected.unshift(compactMiddle(next, remaining, 'oversized recent message'));
      break;
    }
    selected.unshift(next);
    size += next.length + 2;
  }

  const prompt = [...fixed, ...selected].filter(Boolean).join('\n\n');

  const allFormattedLength = [...fixed, ...formattedConversation].join('\n\n').length;
  return {
    prompt,
    originalMessages: request.messages.length,
    includedMessages: systemMessages.length + selected.length,
    truncatedCharacters: Math.max(0, allFormattedLength - prompt.length)
  };
}
