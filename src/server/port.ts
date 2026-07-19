import type { Server } from 'node:http';

export async function listenWithPortRotation(
  server: Server,
  host: string,
  preferredPort: number,
  scanLimit: number
): Promise<number> {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error(`Invalid preferred port: ${preferredPort}`);
  }
  const attempts = Math.max(1, scanLimit + 1);
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    try {
      await listenOnce(server, host, port);
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
    }
  }
  throw new Error(`No available port from ${preferredPort} to ${Math.min(65_535, preferredPort + attempts - 1)}`);
}

function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, host);
  });
}
