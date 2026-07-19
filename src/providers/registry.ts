import type { AgentProxyConfig } from '../config.js';
import { QwenProvider } from './qwen/index.js';
import type { ProviderAdapter } from './types.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  constructor(config: AgentProxyConfig) {
    if (config.providers.qwen.enabled) {
      this.providers.set('qwen', new QwenProvider(config));
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

  get(providerId: string): ProviderAdapter | undefined {
    return this.providers.get(providerId);
  }

  async listModels() {
    const results = await Promise.allSettled([...this.providers.values()].map((provider) => provider.listModels()));
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.close()));
  }
}
