import { loadConfig, removeRuntime, writeRuntime } from './config.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ProviderRegistry } from './providers/registry.js';
import { configureHermes, detectWslGateway } from './integrations/hermes.js';
import { createApiServer } from './server/http.js';
import { listenWithPortRotation } from './server/port.js';

export async function startDaemon(): Promise<void> {
  const config = await loadConfig();
  const registry = new ProviderRegistry(config);
  let stopping = false;
  const servers: ReturnType<typeof createApiServer>[] = [];
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all(servers.map((activeServer) => new Promise<void>((resolve) => {
      activeServer.close(() => resolve());
    })));
    await registry.close();
    await removeRuntime();
    resolveStopped?.();
  };

  const server = createApiServer(config, registry, () => void shutdown());
  servers.push(server);
  const port = await listenWithPortRotation(server, config.server.host, config.server.port, config.server.portScanLimit);
  const wslGateway = await detectWslGateway();
  let wslHost: string | undefined;
  if (wslGateway && wslGateway !== config.server.host) {
    const wslServer = createApiServer(config, registry, () => void shutdown());
    try {
      await listenWithPortRotation(wslServer, wslGateway, port, 0);
      servers.push(wslServer);
      wslHost = wslGateway;
    } catch (error) {
      process.stderr.write(`[AgentProxy] WSL bridge warning: ${(error as Error).message}\n`);
    }
  }
  const runtime = {
    pid: process.pid,
    port,
    host: config.server.host,
    ...(wslHost ? { wslHost } : {}),
    startedAt: new Date().toISOString(),
    version: '0.1.0'
  };
  await writeRuntime(runtime);
  process.stdout.write(`[AgentProxy] online at http://${config.server.host}:${port}/v1\n`);
  if (port !== config.server.port) {
    process.stdout.write(`[AgentProxy] port ${config.server.port} was busy; selected ${port}.\n`);
  }
  if (wslHost) {
    process.stdout.write(`[AgentProxy] WSL bridge at http://${wslHost}:${port}/v1\n`);
  }
  if (config.integrations.hermes.enabled) {
    try {
      const detail = await configureHermes(runtime, config);
      process.stdout.write(`[AgentProxy] Hermes updated: ${detail}\n`);
    } catch (error) {
      process.stderr.write(`[AgentProxy] Hermes integration warning: ${(error as Error).message}\n`);
    }
  }

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await stopped;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startDaemon().catch((error) => {
    process.stderr.write(`[AgentProxy] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
