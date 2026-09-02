import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { startFakestoreFixture, type FixtureHandle, type FakestoreControl } from '@chief-of-staff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchHttp } from './http.js';

/**
 * Tier 0 over real sockets. The fixture shop is the ordinary case; the two
 * hand-rolled servers are the ways a real site fails to answer, which the
 * ladder has to tell apart from a block: a block is content, and these have
 * no content at all.
 */

let shop: FixtureHandle<FakestoreControl>;
/** Accepts the connection and then says nothing, forever. */
let silent: Server;
let silentUrl: string;
/** Redirects once, then answers. */
let redirecting: Server;
let redirectingUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  shop = await startFakestoreFixture();
  await shop.control.setProduct('widget', { title: 'Widget', price: 19.99, stock: 'in_stock' });

  silent = createServer(() => {
    // Deliberately never responds.
  });
  silentUrl = await listen(silent);

  redirecting = createServer((request, response) => {
    if (request.url === '/old') {
      response.writeHead(302, { location: '/new' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>landed</body></html>');
  });
  redirectingUrl = await listen(redirecting);
});

afterAll(async () => {
  await shop.stop();
  await close(silent);
  await close(redirecting);
});

describe('tier 0 against a fixture shop', () => {
  it('fetches the product page with its metadata', async () => {
    const url = `${shop.url}/product/widget`;

    const attempt = await fetchHttp(url);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.html).toContain('data-testid="product-price"');
    expect(attempt.html).toContain('$19.99');
    expect(attempt.meta).toMatchObject({
      tier: 'http',
      url,
      finalUrl: url,
      status: 200,
      redirected: false,
      stealth: false,
    });
    expect(attempt.meta.contentType).toMatch(/^text\/html/u);
    expect(attempt.meta.bytes).toBe(Buffer.byteLength(attempt.html));
    expect(attempt.meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('brings back a missing product as a 404 with its page, for the classifier to read', async () => {
    const attempt = await fetchHttp(`${shop.url}/product/nothing-here`);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.meta.status).toBe(404);
    expect(attempt.html).toContain('fixture-state:not-found');
  });

  it('follows a redirect and reports where it landed', async () => {
    const attempt = await fetchHttp(`${redirectingUrl}/old`);

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.meta).toMatchObject({
      url: `${redirectingUrl}/old`,
      finalUrl: `${redirectingUrl}/new`,
      redirected: true,
      status: 200,
    });
    expect(attempt.html).toContain('landed');
  });
});

describe('tier 0 against a site that does not answer', () => {
  it('reports a server that accepts and then says nothing as a timeout', async () => {
    const attempt = await fetchHttp(`${silentUrl}/anything`, { timeoutMs: 300 });

    expect(attempt).toMatchObject({
      ok: false,
      tier: 'http',
      error: { kind: 'timeout', message: 'no response within 300ms' },
    });
    if (attempt.ok) return;
    expect(attempt.elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it('reports a port nobody listens on as a network error, not a timeout', async () => {
    // Take a port by listening on it, then release it before fetching.
    const placeholder = createServer();
    const url = await listen(placeholder);
    await close(placeholder);

    const attempt = await fetchHttp(`${url}/anything`, { timeoutMs: 5_000 });

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error.kind).toBe('network');
    expect(attempt.error.message).toMatch(/ECONNREFUSED/u);
  });
});
