import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from './server.js';

/**
 * Every other API test uses Fastify's `inject`, which never touches a socket.
 * This is the only place the process a deployment actually starts is proven to
 * bind the configured interface and answer over TCP.
 */

/** An OS-assigned port, so the suite cannot collide with a running server. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

async function environment(): Promise<NodeJS.ProcessEnv> {
  return {
    DATABASE_URL: 'postgres://user@localhost:5432/chief_of_staff',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    PORT: String(await freePort()),
  };
}

const running: RunningServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
});

describe('startServer', () => {
  it('binds the configured host and port, and answers /health there', async () => {
    const config = await environment();
    const server = await startServer(config);
    running.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${String(config['PORT'])}`);

    const response = await fetch(`${server.url}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('releases the port when it is stopped', async () => {
    const server = await startServer(await environment());
    const { url } = server;

    await server.stop();

    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
