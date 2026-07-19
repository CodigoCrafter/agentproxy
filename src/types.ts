export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';

export interface ToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: MessageRole;
  content?: string | Array<{ type?: string; text?: string }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: FunctionTool[];
  tool_choice?: string | { type?: string; function?: { name: string } };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
  temperature?: number;
  max_tokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' };
