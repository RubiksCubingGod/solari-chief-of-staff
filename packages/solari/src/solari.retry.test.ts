import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createSolariClient } from './solari.js';

/**
 * The one test in this package that drives the real vendor client.
 *
 * It makes no live calls: the client is pointed at a local server via
 * `baseUrl`. That is the only honest way to prove the claim, because the claim
 * is about the SDK's own behavior. A faked client would prove nothing —
 * `isRetryableError()` in the shipped source is `return true` unconditionally
 * and the retry loop wraps `POST /sessions`, so a create that succeeds
 * server-side but times out client-side re-sends and mints a second billable
 * session whose id we never see. Its concurrency slot is then held until the
 * orphan reaper runs, roughly three and a half minutes later.
 *
 * The provider closes that hole by pinning `maxAttempts: 1`. This test is the
 * guard on that line, and it failed with `expected 2 to be 1` before that pin
 * existed — the duplicate is observed, not assumed.
 */

/** The SDK's fixed inter-attempt backoff. A re-send would land this long after the timeout. */
const SDK_BACKOFF_MS = 500;

/** How long to keep watching for a second create after the first one is abandoned. */
const RETRY_WATCH_MS = SDK_BACKOFF_MS * 3;

interface StalledGateway {
  readonly url: string;
  readonly createCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * A gateway that accepts `POST /sessions` and answers far too late — the
 * server-side success the client never gets to see.
 */
async function startStalledGateway(): Promise<StalledGateway> {
  let createCount = 0;
  const sockets = new Set<{ destroy: () => void }>();
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/sessions') createCount += 1;
    // Long enough that the client always gives up first, on any machine.
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'created-but-never-seen' }));
      } catch {
        // The client tore the socket down already. That is the scenario.
      }
    }, 30_000);
    timers.add(timer);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    createCount: () => createCount,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Poll until the gateway has actually seen a create, so a slow machine cannot fake a pass. */
async function waitForFirstCreate(gateway: StalledGateway): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (gateway.createCount() === 0) {
    if (Date.now() > deadline) throw new Error('the gateway never received a create');
    await delay(25);
  }
}

let gateway: StalledGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe('createSolariClient', () => {
  it('sends exactly one POST /sessions when a create succeeds server-side but times out client-side', async () => {
    gateway = await startStalledGateway();
    const client = createSolariClient({
      apiKey: 'test-key',
      baseUrl: gateway.url,
      // Generous enough that the request always reaches the server even on a
      // loaded machine, short enough that the client is the one who gives up.
      timeoutMs: 2_000,
    });

    const create = client.sessions.create({}).then(
      () => 'resolved',
      () => 'rejected',
    );

    await waitForFirstCreate(gateway);
    await expect(create).resolves.toBe('rejected');

    // Proving a non-event: watch past the SDK's fixed backoff, so a re-send
    // would have landed by now if the pin were missing.
    await delay(RETRY_WATCH_MS);

    // Two would mean a duplicate billable session and a held slot. This is the
    // assertion the whole provider-owned-retry design exists to keep true.
    expect(gateway.createCount()).toBe(1);

    await client.close();
  });

  it('still surfaces the failure rather than swallowing it', async () => {
    gateway = await startStalledGateway();
    const client = createSolariClient({ apiKey: 'test-key', baseUrl: gateway.url, timeoutMs: 2_000 });

    // A silent success here would be worse than the duplicate: the caller would
    // believe it had no session when the gateway believes it has one.
    await expect(client.sessions.create({})).rejects.toThrow();

    await client.close();
  });
});
