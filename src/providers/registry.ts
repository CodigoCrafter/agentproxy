import { providerIds, type AgentProxyConfig, type ProviderId } from '../config.js';
import { QwenProvider } from './qwen/index.js';
import type { ProviderAdapter } from './types.js';

export type ProviderFactory = (config: AgentProxyConfig) => ProviderAdapter;

const defaultFactories: Partial<Record<ProviderId, ProviderFactory>> = {
  qwen: (config) => new QwenProvider(config)
};

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(config: AgentProxyConfig, factories = defaultFactories) {
    for (const providerId of providerIds) {
      if (!config.providers[providerId].enabled) continue;
      const factory = factories[providerId];
      if (!factory) throw new Error(`Provider enabled but not implemented: ${providerId}`);
      this.providers.set(providerId, factory(config));
    }
  }

  resolve(modelId: string): { provider: ProviderAdapter; model: string } {
    const separator = modelId.indexOf('/');
    const providerId = separator === -1 ? 'qwen' : modelId.slice(0, separator);
    const model = separator === -1 ? modelId : modelId.slice(separator + 1);
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not configured: ${providerId}`);
    return { provider, model };
  }

  get(providerId: ProviderId): ProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  entries(): Array<[ProviderId, ProviderAdapter]> {
    return [...this.providers.entries()] as Array<[ProviderId, ProviderAdapter]>;
  }

  async listModels() {
    const results = await Promise.allSettled([...this.providers.values()].map((provider) => provider.listModels()));
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.close()));
  }
}
