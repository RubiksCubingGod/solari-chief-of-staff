import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startWebDevServer } from './testing/dev-server';

/**
 * The shell, proven the only way that answers the question a page test is
 * asked: through the dev server the developer actually runs, over HTTP, on
 * rendered markup. A component rendered in isolation would prove React works;
 * this proves the app boots, the layout wraps the page, and the configured API
 * base URL survives the trip from the environment into the response body.
 */

interface Stoppable {
  stop(): Promise<void>;
}

/**
 * Everything this file starts, newest first. Registering here rather than in a
 * `finally` means a failed assertion tears down exactly as reliably as a passing
 * one, and a start that throws half way still releases what came before it.
 */
const started: Stoppable[] = [];

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

async function track<T extends Stoppable>(instance: T): Promise<T> {
  started.push(instance);
  return Promise.resolve(instance);
}

interface StubApi extends Stoppable {
  readonly url: string;
  /** Every path the page asked this server for, in order. */
  readonly requestedPaths: readonly string[];
}

/** The signed-in account the stub API vouches for. */
const STUB_USER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };

/** What a browser holding a session presents. The stub never inspects it. */
const SESSION_COOKIE = 'cos_session=whatever-the-stub-vouches-for';

/**
 * Stands in for the Fastify server. The shell only needs to prove it can reach
 * the API and read a response; making that a real API would drag a database
 * into a test about whether a page renders. It answers `/auth/session` because
 * every page is behind the guard now, and the guard is one HTTP call - which is
 * exactly the shape a stub can stand in for. Whether the guard is *right* is
 * `auth-guard.integration.test.ts`, against a real API.
 */
async function startStubApi(): Promise<StubApi> {
  const requestedPaths: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    requestedPaths.push(path);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(path === '/auth/session' ? STUB_USER : { status: 'ok' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requestedPaths,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('the dashboard shell', () => {
  it(
    'renders the smoke page through the dev server against the configured API',
    async () => {
      const api = await track(await startStubApi());
      const web = await track(await startWebDevServer({ apiBaseUrl: api.url }));

      const response = await fetch(`${web.url}/`, { headers: { cookie: SESSION_COOKIE } });
      expect(response.status).toBe(200);
      const html = await response.text();

      // The layout wrapped the page: the product name and every section of the
      // navigation are in the markup the server produced, not painted in later
      // by a client bundle.
      expect(html).toContain('Chief of Staff');
      for (const section of ['Watches', 'Calendar', 'Tasks']) {
        expect(html).toContain(section);
      }
      // The page itself rendered, and it rendered the base URL this test put in
      // the environment rather than a compiled-in default.
      expect(html).toContain('Overview');
      expect(html).toContain(api.url);
      // It reached the API over HTTP rather than reporting reachability it
      // never checked - and it asked the API who was asking rather than
      // deciding that for itself.
      expect(api.requestedPaths).toContain('/health');
      expect(api.requestedPaths).toContain('/auth/session');
      expect(html).toContain('reachable');
      // React marks the join between a literal and an interpolated value with
      // an empty comment so it can find the boundary again when it hydrates.
      // A reader sees one sentence, so the assertion is made against one.
      expect(html.replaceAll('<!-- -->', '')).toContain(`Signed in as ${STUB_USER.email}`);

      // Teardown is a property of the handle, not of this file remembering to
      // do it: stopping twice is harmless and the port is genuinely released.
      await web.stop();
      await web.stop();
      await expect(fetch(`${web.url}/`, { headers: { cookie: SESSION_COOKIE } })).rejects.toThrow();
    },
    240_000,
  );
});
