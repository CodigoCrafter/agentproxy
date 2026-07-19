import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentProxyConfig, RuntimeState } from '../config.js';

const execFileAsync = promisify(execFile);

interface Runner {
  command: string;
  prefix: string[];
  label: string;
  environment: 'local' | 'wsl';
}

export async function configureHermes(runtime: RuntimeState, config: AgentProxyConfig): Promise<string> {
  const runner = await findHermes();
  const endpointHost = runner.environment === 'wsl' ? runtime.wslHost : runtime.host;
  if (!endpointHost) {
    throw new Error('A ponte de rede do WSL nao esta disponivel. Reinicie o AgentProxy e tente novamente.');
  }
  const baseUrl = `http://${endpointHost}:${runtime.port}/v1`;
  const values: Array<[string, string]> = [
    ['model.provider', 'custom'],
    ['model.base_url', baseUrl],
    ['model.default', config.defaultModel],
    ['model.api_key', config.apiKey],
    ['model.api_mode', 'openai']
  ];

  for (const [key, value] of values) {
    await execFileAsync(runner.command, [...runner.prefix, 'config', 'set', key, value], {
      windowsHide: true,
      timeout: 15_000
    });
  }
  return `${runner.label}: ${baseUrl}`;
}

async function findHermes(): Promise<Runner> {
  try {
    await execFileAsync('hermes', ['--version'], { windowsHide: true, timeout: 5_000 });
    return { command: 'hermes', prefix: [], label: 'Hermes local', environment: 'local' };
  } catch {
    if (process.platform !== 'win32') {
      const localHermes = path.join(os.homedir(), '.local', 'bin', 'hermes');
      try {
        await access(localHermes, constants.X_OK);
        return { command: localHermes, prefix: [], label: 'Hermes local', environment: 'local' };
      } catch {
        throw new Error('Hermes nao encontrado no PATH nem em ~/.local/bin/hermes.');
      }
    }
  }

  try {
    const result = await execFileAsync('wsl.exe', ['--exec', 'sh', '-lc', 'command -v hermes'], {
      windowsHide: true,
      timeout: 10_000
    });
    const executable = result.stdout.trim().split(/\r?\n/).at(-1);
    if (!executable?.startsWith('/')) throw new Error('invalid WSL executable');
    return { command: 'wsl.exe', prefix: ['--exec', executable], label: 'Hermes no WSL', environment: 'wsl' };
  } catch {
    throw new Error('Hermes nao encontrado no Windows nem na distribuicao WSL padrao.');
  }
}

export async function detectWslGateway(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  try {
    const result = await execFileAsync('wsl.exe', ['--exec', 'ip', 'route', 'show', 'default'], {
      windowsHide: true,
      timeout: 10_000
    });
    const match = result.stdout.match(/\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
