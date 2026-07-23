import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const providerIds = ['qwen', 'kimi', 'chatgpt', 'gemini'] as const;
export type ProviderId = typeof providerIds[number];

export function isProviderId(value: string): value is ProviderId {
  return providerIds.includes(value as ProviderId);
}

export interface ProviderConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface BrowserProviderConfig extends ProviderConfig {
  browser: 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';
  headless: boolean;
  maxConcurrentRequests: number;
  queueTimeoutMs: number;
  rateLimitCooldownMs: number;
}

export interface AgentProxyConfig {
  version: 1;
  profile: 'hermes';
  defaultModel: string;
  apiKey: string;
  server: {
    host: string;
    port: number;
    portScanLimit: number;
  };
  context: {
    maxHistoryMessages: number;
    maxInputChars: number;
    maxSystemChars: number;
    maxToolResultChars: number;
    exposeReasoning: boolean;
  };
  providers: {
    qwen: BrowserProviderConfig;
    kimi: ProviderConfig;
    chatgpt: ProviderConfig;
    gemini: ProviderConfig;
  };
  integrations: {
    hermes: {
      enabled: boolean;
    };
  };
}

export interface RuntimeState {
  pid: number;
  port: number;
  host: string;
  wslHost?: string;
  startedAt: string;
  version: string;
}

export function getAgentProxyHome(): string {
  return process.env.AGENTPROXY_HOME || path.join(os.homedir(), '.agentproxy');
}

export function getPaths() {
  const home = getAgentProxyHome();
  const providers = path.join(home, 'providers');
  return {
    home,
    config: path.join(home, 'config.json'),
    runtime: path.join(home, 'runtime.json'),
    logs: path.join(home, 'logs'),
    log: path.join(home, 'logs', 'agentproxy.log'),
    telemetry: path.join(home, 'logs', 'telemetry.jsonl'),
    providers,
    providerHome: (providerId: ProviderId) => path.join(providers, providerId),
    qwenProfile: path.join(providers, 'qwen', 'browser-profile')
  };
}

export function createDefaultConfig(): AgentProxyConfig {
  return {
    version: 1,
    profile: 'hermes',
    defaultModel: 'qwen/qwen3.7-max-no-thinking',
    apiKey: `apx_${randomBytes(24).toString('base64url')}`,
    server: {
      host: '127.0.0.1',
      port: 3091,
      portScanLimit: 50
    },
    context: {
      maxHistoryMessages: 16,
      maxInputChars: 64_000,
      maxSystemChars: 24_000,
      maxToolResultChars: 4_000,
      exposeReasoning: false
    },
    providers: {
      qwen: {
        enabled: true,
        browser: 'chromium',
        headless: true,
        requestTimeoutMs: 180_000,
        idleTimeoutMs: 75_000,
        maxConcurrentRequests: 2,
        queueTimeoutMs: 120_000,
        rateLimitCooldownMs: 30 * 60_000
      },
      kimi: {
        enabled: false,
        requestTimeoutMs: 180_000,
        idleTimeoutMs: 75_000
      },
      chatgpt: {
        enabled: false,
        requestTimeoutMs: 180_000,
        idleTimeoutMs: 75_000
      },
      gemini: {
        enabled: false,
        requestTimeoutMs: 180_000,
        idleTimeoutMs: 75_000
      }
    },
    integrations: {
      hermes: {
        enabled: false
      }
    }
  };
}

export function applyHermesProfile(config: AgentProxyConfig): AgentProxyConfig {
  config.profile = 'hermes';
  config.context.maxHistoryMessages = Math.min(config.context.maxHistoryMessages, 16);
  config.context.maxInputChars = Math.min(config.context.maxInputChars, 64_000);
  config.context.maxSystemChars = Math.min(config.context.maxSystemChars, 24_000);
  config.context.maxToolResultChars = Math.min(config.context.maxToolResultChars, 4_000);
  config.context.exposeReasoning = false;
  for (const providerId of providerIds) {
    const provider = config.providers[providerId];
    provider.requestTimeoutMs = Math.max(provider.requestTimeoutMs, 180_000);
    provider.idleTimeoutMs = Math.max(provider.idleTimeoutMs, 75_000);
  }
  return config;
}

export async function ensureHome(): Promise<void> {
  const paths = getPaths();
  await mkdir(paths.logs, { recursive: true });
  await mkdir(paths.providers, { recursive: true });
  await mkdir(path.dirname(paths.qwenProfile), { recursive: true });
}

export async function loadConfig(): Promise<AgentProxyConfig> {
  await ensureHome();
  const paths = getPaths();
  try {
    const raw = await readFile(paths.config, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as PartialAgentProxyConfig;
    return mergeConfig(createDefaultConfig(), parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const config = createDefaultConfig();
    await saveConfig(config);
    return config;
  }
}

export type PartialAgentProxyConfig = Omit<Partial<AgentProxyConfig>, 'server' | 'context' | 'providers' | 'integrations'> & {
  server?: Partial<AgentProxyConfig['server']>;
  context?: Partial<AgentProxyConfig['context']>;
  providers?: { [K in ProviderId]?: Partial<AgentProxyConfig['providers'][K]> };
  integrations?: { hermes?: Partial<AgentProxyConfig['integrations']['hermes']> };
};

export function mergeConfig(base: AgentProxyConfig, value: PartialAgentProxyConfig): AgentProxyConfig {
  return {
    ...base,
    ...value,
    server: { ...base.server, ...value.server },
    context: { ...base.context, ...value.context },
    providers: {
      ...base.providers,
      ...value.providers,
      qwen: { ...base.providers.qwen, ...value.providers?.qwen },
      kimi: { ...base.providers.kimi, ...value.providers?.kimi },
      chatgpt: { ...base.providers.chatgpt, ...value.providers?.chatgpt },
      gemini: { ...base.providers.gemini, ...value.providers?.gemini }
    },
    integrations: {
      ...base.integrations,
      ...value.integrations,
      hermes: { ...base.integrations.hermes, ...value.integrations?.hermes }
    }
  };
}

export async function saveConfig(config: AgentProxyConfig): Promise<void> {
  await ensureHome();
  const configPath = getPaths().config;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(configPath, 0o600);
}

export async function readRuntime(): Promise<RuntimeState | null> {
  try {
    return JSON.parse(await readFile(getPaths().runtime, 'utf8')) as RuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeRuntime(state: RuntimeState): Promise<void> {
  await ensureHome();
  await writeFile(getPaths().runtime, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function removeRuntime(): Promise<void> {
  await unlink(getPaths().runtime).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
