import type { ProviderStreamEvent } from '../types.js';
import type { ProviderId } from '../config.js';

export interface ModelInfo {
  id: string;
  provider: string;
  ownedBy: string;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    reasoning: boolean;
    vision: boolean;
  };
}

export interface ProviderRequest {
  model: string;
  prompt: string;
  sessionId: string;
  thinking: boolean;
  signal: AbortSignal;
  idleTimeoutMs: number;
}

export interface AuthStatus {
  authenticated: boolean;
  detail: string;
}

export interface AuthenticationOptions {
  force?: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly idleTimeoutMs: number;
  authenticate?(options?: AuthenticationOptions): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  listModels(): Promise<ModelInfo[]>;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
  close(): Promise<void>;
}
