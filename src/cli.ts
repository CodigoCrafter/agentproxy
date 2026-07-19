#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {
  applyHermesProfile,
  getPaths,
  isProviderId,
  loadConfig,
  providerIds,
  readRuntime,
  removeRuntime,
  saveConfig,
  type AgentProxyConfig,
  type RuntimeState
} from './config.js';
import { startDaemon } from './daemon.js';
import { ProviderRegistry } from './providers/registry.js';
import { configureHermes } from './integrations/hermes.js';

const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

async function main(): Promise<void> {
  switch (command) {
    case 'setup': await setup(); break;
    case 'login': await login(args[0]); break;
    case 'hermes': await hermesQuickstart(); break;
    case 'on': await on(args.includes('--foreground')); break;
    case 'off': await off(); break;
    case 'status': await status(); break;
    case 'doctor': await doctor(); break;
    case 'models': await models(); break;
    case 'use': await useModel(args[0]); break;
    case 'connect': await connect(args[0]); break;
    case 'config': await showConfig(); break;
    case 'version':
    case '--version':
    case '-v': process.stdout.write('AgentProxy 0.1.0\n'); break;
    case 'help':
    case '--help':
    case '-h': help(); break;
    default:
      throw new Error(`Comando desconhecido: ${command}. Execute: proxy help`);
  }
}

async function setup(): Promise<void> {
  const config = await loadConfig();
  process.stdout.write('\nAgentProxy - configuracao inicial\n\n');
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (interactive) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const portAnswer = await readline.question(`Porta preferida [${config.server.port}]: `);
      if (portAnswer.trim()) {
        const port = Number(portAnswer);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Porta invalida.');
        config.server.port = port;
      }
      const qwenAnswer = await readline.question('Configurar Qwen agora? [S/n]: ');
      config.providers.qwen.enabled = !/^n/i.test(qwenAnswer.trim());
    } finally {
      readline.close();
    }
  }

  await saveConfig(config);
  process.stdout.write(`Configuracao salva em ${getPaths().config}\n`);

  if (config.providers.qwen.enabled && !args.includes('--skip-login')) {
    const registry = new ProviderRegistry(config);
    try {
      const qwen = registry.get('qwen');
      if (!qwen?.authenticate) throw new Error('Adaptador Qwen indisponivel.');
      await qwen.authenticate();
    } catch (error) {
      const message = (error as Error).message;
      if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
        process.stdout.write('Chromium do Playwright ausente. Instalando automaticamente...\n');
        await installBrowser();
        const qwen = registry.get('qwen');
        if (!qwen?.authenticate) throw new Error('Adaptador Qwen indisponivel.');
        await qwen.authenticate();
      } else {
        throw error;
      }
    } finally {
      await registry.close();
    }
  }

  process.stdout.write('\nPronto. Inicie com: proxy on\n');
}

async function hermesQuickstart(): Promise<void> {
  const config = applyHermesProfile(await loadConfig());
  const paths = getPaths();
  process.stdout.write('\nAgentProxy Hermes quickstart\n\n');

  config.providers.qwen.enabled = true;
  await saveConfig(config);

  const registry = new ProviderRegistry(config);
  try {
    const qwen = registry.get('qwen');
    if (!qwen?.authenticate) throw new Error('Adaptador Qwen indisponivel.');
    const auth = await qwen.authStatus();
    if (!auth.authenticated) {
      process.stdout.write('Qwen ainda nao esta logado. Abrindo login...\n');
      await qwen.authenticate();
    }
  } catch (error) {
    const message = (error as Error).message;
    if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
      process.stdout.write('Chromium do Playwright ausente. Instalando automaticamente...\n');
      await installBrowser();
      const qwen = registry.get('qwen');
      if (!qwen?.authenticate) throw new Error('Adaptador Qwen indisponivel.');
      await qwen.authenticate();
    } else {
      throw error;
    }
  } finally {
    await registry.close();
  }

  await on(false);
  await connect('hermes');
  const runtime = await readRuntime();
  process.stdout.write('\nPronto para Hermes.\n');
  if (runtime) {
    process.stdout.write(`Endpoint: http://${runtime.host}:${runtime.port}/v1\n`);
    if (runtime.wslHost) process.stdout.write(`WSL: http://${runtime.wslHost}:${runtime.port}/v1\n`);
  }
  process.stdout.write(`Config: ${paths.config}\n`);
}

async function login(providerId: string | undefined): Promise<void> {
  if (!providerId || !isProviderId(providerId)) {
    throw new Error(`Provedor invalido. Disponiveis: ${providerIds.join(', ')}`);
  }
  const config = await loadConfig();
  config.providers[providerId].enabled = true;
  const registry = new ProviderRegistry(config);
  try {
    const provider = registry.get(providerId);
    if (!provider?.authenticate) throw new Error(`Adaptador ${providerId} indisponivel.`);
    await saveConfig(config);
    process.stdout.write(`Abrindo uma nova sessao do ${providerId}...\n`);
    await provider.authenticate({ force: true });
  } finally {
    await registry.close();
  }
}

async function on(foreground: boolean): Promise<void> {
  if (foreground) {
    await startDaemon();
    return;
  }

  const existing = await readRuntime();
  if (existing && await health(existing)) {
    process.stdout.write(`AgentProxy ja esta online em http://${existing.host}:${existing.port}/v1\n`);
    return;
  }
  if (existing) await removeRuntime();

  const paths = getPaths();
  const daemonPath = fileURLToPath(new URL('./daemon.js', import.meta.url));
  const logFd = openSync(paths.log, 'a');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await delay(250);
    const runtime = await readRuntime();
    if (runtime && await health(runtime)) {
      process.stdout.write(`AgentProxy online: http://${runtime.host}:${runtime.port}/v1\n`);
      if (runtime.port !== (await loadConfig()).server.port) {
        process.stdout.write(`Porta preferida ocupada; usando ${runtime.port}.\n`);
      }
      return;
    }
  }
  throw new Error(`O AgentProxy nao iniciou. Consulte ${paths.log}`);
}

async function off(): Promise<void> {
  const runtime = await readRuntime();
  if (!runtime) {
    process.stdout.write('AgentProxy ja esta desligado.\n');
    return;
  }
  const config = await loadConfig();
  try {
    const response = await fetch(`http://${runtime.host}:${runtime.port}/_internal/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    await removeRuntime();
    process.stdout.write('O processo nao respondeu; estado antigo removido.\n');
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await readRuntime()) await delay(100);
  process.stdout.write('AgentProxy desligado.\n');
}

async function status(): Promise<void> {
  const runtime = await readRuntime();
  if (!runtime || !(await health(runtime))) {
    process.stdout.write('AgentProxy: offline\n');
    return;
  }
  const config = await loadConfig();
  process.stdout.write([
    'AgentProxy: online',
    `Endpoint: http://${runtime.host}:${runtime.port}/v1`,
    ...(runtime.wslHost ? [`WSL: http://${runtime.wslHost}:${runtime.port}/v1`] : []),
    `Modelo: ${config.defaultModel}`,
    `PID: ${runtime.pid}`,
    `Iniciado: ${runtime.startedAt}`,
    ''
  ].join('\n'));
}

async function doctor(): Promise<void> {
  const config = await loadConfig();
  const runtime = await readRuntime();
  const registry = new ProviderRegistry(config);
  const checks: Array<[string, boolean, string]> = [];
  checks.push(['Configuracao', true, getPaths().config]);
  checks.push(['Servidor', !!runtime && await health(runtime), runtime ? `porta ${runtime.port}` : 'offline']);
  for (const providerId of providerIds) {
    const provider = registry.get(providerId);
    const name = providerId === 'qwen' ? 'Qwen' : providerId === 'chatgpt' ? 'ChatGPT' : providerId[0].toUpperCase() + providerId.slice(1);
    if (provider) {
      const auth = await provider.authStatus();
      checks.push([name, auth.authenticated, auth.detail]);
    } else checks.push([name, false, 'desabilitado']);
  }
  await registry.close();

  process.stdout.write('\nDiagnostico AgentProxy\n\n');
  for (const [name, ok, detail] of checks) {
    process.stdout.write(`${ok ? '[OK]' : '[!!]'} ${name}: ${detail}\n`);
  }
}

async function models(): Promise<void> {
  const runtime = await requireRunning();
  const config = await loadConfig();
  const response = await fetch(`http://${runtime.host}:${runtime.port}/v1/models`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json() as { data?: Array<{ id: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  for (const model of body.data || []) process.stdout.write(`${model.id}\n`);
}

async function useModel(model: string | undefined): Promise<void> {
  if (!model) throw new Error('Informe um modelo. Exemplo: proxy use qwen/qwen3.7-max-no-thinking');
  const config = await loadConfig();
  config.defaultModel = model;
  await saveConfig(config);
  process.stdout.write(`Modelo padrao: ${model}\n`);
}

async function connect(target: string | undefined): Promise<void> {
  if (target !== 'hermes') throw new Error('Integracao disponivel: proxy connect hermes');
  const runtime = await requireRunning();
  const config = applyHermesProfile(await loadConfig());
  const detail = await configureHermes(runtime, config);
  config.integrations.hermes.enabled = true;
  await saveConfig(config);
  process.stdout.write(`Hermes conectado. ${detail}\n`);
  process.stdout.write('A porta sera atualizada automaticamente nas proximas inicializacoes.\n');
}

async function showConfig(): Promise<void> {
  const config = await loadConfig();
  const safe = { ...config, apiKey: `${config.apiKey.slice(0, 8)}...` };
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

async function requireRunning(): Promise<RuntimeState> {
  const runtime = await readRuntime();
  if (!runtime || !(await health(runtime))) throw new Error('AgentProxy offline. Execute: proxy on');
  return runtime;
}

async function health(runtime: RuntimeState): Promise<boolean> {
  try {
    const response = await fetch(`http://${runtime.host}:${runtime.port}/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function help(): void {
  process.stdout.write(`
AgentProxy 0.1.0

Uso:
  proxy setup              Configura provedores e login
  proxy login <provedor>   Limpa a sessao e abre um novo login
  proxy hermes             Configura Qwen, inicia e conecta o Hermes
  proxy on                 Inicia em segundo plano
  proxy on --foreground    Inicia mostrando os logs
  proxy off                Desliga com encerramento seguro
  proxy status             Mostra endpoint e modelo atual
  proxy doctor             Diagnostica configuracao e login
  proxy models             Lista modelos disponiveis
  proxy use <modelo>       Define o modelo padrao
  proxy connect hermes     Configura e acompanha a porta no Hermes
  proxy config             Mostra a configuracao sem expor a chave
`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installBrowser(): Promise<void> {
  return new Promise((resolve, reject) => {
    const playwrightCli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));
    const child = spawn(process.execPath, [playwrightCli, 'install', 'chromium'], {
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Falha ao instalar Chromium: codigo ${code}`)));
  });
}

main().catch((error) => {
  process.stderr.write(`Erro: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
