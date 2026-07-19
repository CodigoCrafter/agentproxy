import { randomUUID } from 'node:crypto';

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParserOutput {
  text: string;
  toolCalls: ParsedToolCall[];
  malformedToolCall?: string;
}

const START = '<tool_call>';
const END = '</tool_call>';
const LEGACY_START = '[tool_calls]';
const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

export class StreamingToolParser {
  private buffer = '';
  private count = 0;

  constructor(
    private readonly maxBuffer = 256_000,
    private readonly allowedTools?: Set<string>
  ) {}

  feed(chunk: string): ParserOutput {
    this.buffer += chunk;
    let text = '';
    const toolCalls: ParsedToolCall[] = [];

    while (this.buffer) {
      const xmlStartIndex = this.buffer.indexOf(START);
      const legacyStartIndex = this.buffer.indexOf(LEGACY_START);
      if (legacyStartIndex !== -1 && (xmlStartIndex === -1 || legacyStartIndex < xmlStartIndex)) {
        if (legacyStartIndex > 0) text += this.buffer.slice(0, legacyStartIndex);
        this.buffer = this.buffer.slice(legacyStartIndex);
        if (this.buffer.length > this.maxBuffer) {
          const parsed = this.parseLeakedJson(this.buffer);
          if (parsed.length) toolCalls.push(...parsed);
          else text += this.buffer;
          this.buffer = '';
        }
        break;
      }

      const startIndex = xmlStartIndex;
      if (startIndex === -1) {
        if (
          this.maybeLeakedJsonToolCall(this.buffer)
          || this.maybeHeadlessToolCall(this.buffer)
          || this.maybeTruncatedToolCall(this.buffer)
        ) {
          if (this.buffer.length > this.maxBuffer) {
            const parsed = this.parseLeakedJson(this.buffer);
            if (parsed.length) toolCalls.push(...parsed);
            else text += this.buffer;
            this.buffer = '';
          }
          break;
        }
        const keep = Math.min(this.buffer.length, Math.max(START.length, LEGACY_START.length) - 1);
        text += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(-keep);
        break;
      }

      if (startIndex > 0) {
        text += this.buffer.slice(0, startIndex);
        this.buffer = this.buffer.slice(startIndex);
      }

      const endIndex = this.buffer.indexOf(END, START.length);
      if (endIndex === -1) {
        if (this.buffer.length > this.maxBuffer) {
          text += this.buffer;
          this.buffer = '';
        }
        break;
      }

      const raw = this.buffer.slice(START.length, endIndex).trim();
      this.buffer = this.buffer.slice(endIndex + END.length);
      const parsed = this.parse(raw);
      if (parsed) toolCalls.push(parsed);
      else text += `${START}${raw}${END}`;
    }

    return { text, toolCalls };
  }

  flush(): ParserOutput {
    const output = this.feed('');
    const leaked = this.parseLeakedJson(this.buffer);
    if (leaked.length) {
      output.toolCalls.push(...leaked);
      this.buffer = '';
      return output;
    }
    if (this.looksLikeTruncatedToolCall(this.buffer)) {
      output.malformedToolCall = this.buffer;
      this.buffer = '';
      return output;
    }
    if (this.looksLikeMalformedToolBlock(this.buffer)) {
      output.malformedToolCall = this.buffer;
      this.buffer = '';
      return output;
    }
    output.text += this.buffer;
    this.buffer = '';
    return output;
  }

  getToolCallCount(): number {
    return this.count;
  }

  private parse(raw: string): ParsedToolCall | null {
    try {
      const value = JSON.parse(raw) as {
        name?: string;
        arguments?: Record<string, unknown> | string;
        function?: { name?: string; arguments?: Record<string, unknown> | string };
      };
      const name = value.name || value.function?.name;
      if (!name) return null;
      const rawArguments = value.arguments ?? value.function?.arguments ?? {};
      const args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments;
      if (!this.isAllowed(name)) return null;
      this.count += 1;
      return { id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: args };
    } catch {
      return null;
    }
  }

  private parseLeakedJson(raw: string): ParsedToolCall[] {
    const normalized = this.extractJsonCandidate(raw);
    if (!normalized) return [];

    try {
      const values = this.parseJsonValues(normalized);
      if (!values?.length) return [];
      const candidates = values.flatMap((value) => this.expandCandidates(value));
      const calls = candidates
        .map((candidate) => this.parseCandidate(candidate))
        .filter((call): call is ParsedToolCall => Boolean(call));
      if (calls.length !== candidates.length) return [];
      return calls;
    } catch {
      return [];
    }
  }

  private parseCandidate(candidate: unknown): ParsedToolCall | null {
    if (!candidate || typeof candidate !== 'object') return null;
    const value = candidate as {
      name?: unknown;
      arguments?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (value.type && value.type !== 'function') return null;
    const name = typeof value.name === 'string'
      ? value.name
      : typeof value.function?.name === 'string'
        ? value.function.name
        : undefined;
    if (!name || !this.isAllowed(name)) return null;

    const rawArguments = value.arguments ?? value.function?.arguments ?? {};
    let args: unknown = rawArguments;
    if (typeof rawArguments === 'string') args = JSON.parse(rawArguments || '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

    this.count += 1;
    return { id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: args as Record<string, unknown> };
  }

  private expandCandidates(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== 'object') return [];
    const value = parsed as { tool_calls?: unknown; calls?: unknown };
    if (Array.isArray(value.tool_calls)) return value.tool_calls;
    if (Array.isArray(value.calls)) return value.calls;
    return [parsed];
  }

  private extractJsonCandidate(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const fenced = trimmed.match(JSON_FENCE);
    let candidate = (fenced ? fenced[1].trim() : trimmed)
      .replace(/\[\/?tool_calls\]/gi, '')
      .replace(/<\/?tool_calls?>/gi, '')
      .trim();
    const headless = candidate.match(/^([A-Za-z_][\w-]*)"\s*,\s*"arguments"\s*:/);
    if (headless && this.isAllowed(headless[1])) candidate = `{"name":"${candidate}`;
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) return null;
    if (!this.looksLikeToolJson(candidate)) return null;
    return candidate;
  }

  private parseJsonValues(value: string): unknown[] | null {
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      // Some Qwen responses contain consecutive tool-call objects without an array.
    }

    const values: unknown[] = [];
    let index = 0;
    while (index < value.length) {
      while (index < value.length && /\s/.test(value[index])) index += 1;
      if (index >= value.length) break;
      if (value[index] !== '{' && value[index] !== '[') return null;

      const start = index;
      const stack: string[] = [];
      let quoted = false;
      let escaped = false;
      for (; index < value.length; index += 1) {
        const character = value[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') {
          quoted = true;
          continue;
        }
        if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
          const opening = stack.pop();
          if ((character === '}' && opening !== '{') || (character === ']' && opening !== '[')) return null;
          if (stack.length === 0) {
            index += 1;
            break;
          }
        }
      }
      if (quoted || stack.length || index <= start) return null;
      try {
        values.push(JSON.parse(value.slice(start, index)) as unknown);
      } catch {
        return null;
      }
    }
    return values.length ? values : null;
  }

  private maybeLeakedJsonToolCall(value: string): boolean {
    const trimmed = value.trimStart();
    if (trimmed.toLowerCase().startsWith(LEGACY_START)) return true;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('```')) return false;
    return this.looksLikeToolJson(trimmed);
  }

  private maybeTruncatedToolCall(value: string): boolean {
    if (!this.allowedTools?.size) return false;
    const trimmed = value.trimStart();
    return /^(?:[A-Za-z_][\w-]*|"[A-Za-z_][\w-]*)"\s*:/.test(trimmed);
  }

  private maybeHeadlessToolCall(value: string): boolean {
    if (!this.allowedTools?.size) return false;
    const match = value.trimStart().match(/^([A-Za-z_][\w-]*)"\s*,\s*"arguments"\s*:/);
    return Boolean(match && this.allowedTools.has(match[1]));
  }

  private looksLikeTruncatedToolCall(value: string): boolean {
    const trimmed = value.trim();
    return this.maybeTruncatedToolCall(trimmed) && /}\s*}\s*$/.test(trimmed);
  }

  private looksLikeMalformedToolBlock(value: string): boolean {
    if (!this.allowedTools?.size) return false;
    const trimmed = value.trimStart();
    if (/\[\/?tool_calls\]|<\/?tool_calls?>/i.test(trimmed)) return true;
    return this.maybeHeadlessToolCall(trimmed)
      || ((trimmed.startsWith('{') || trimmed.startsWith('[')) && this.looksLikeToolJson(trimmed));
  }

  private looksLikeToolJson(value: string): boolean {
    return /"tool_calls"|"function"|"arguments"|"name"/.test(value);
  }

  private isAllowed(name: string): boolean {
    return !this.allowedTools || this.allowedTools.has(name);
  }
}
