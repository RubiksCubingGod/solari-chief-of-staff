import { describe, expect, it } from 'vitest';

import { createHttpCrudClient, type CrudResponse } from './crud.js';

/**
 * The parts of the client the integration suite cannot reach through a healthy
 * server: what a caller is told when the server answers something other than an
 * error envelope, and what it is told when nothing answers at all. Both are the
 * text a real person ends up reading, so neither can be left to chance.
 */

const BASE = 'http://api.test';

/**
 * Stands in for whatever a deployment ends up presenting. Its shape does not
 * matter to these tests; that the client sends exactly what it was handed, and
 * invents nothing of its own, is the whole point.
 */
const TEST_CREDENTIAL = (caller: string): Record<string, string> => ({
  cookie: `session=${caller}`,
});

/** The three things `fetch` accepts, each as the URL it means. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function clientAnswering(answer: (url: string, init?: RequestInit) => Response): {
  request: (path: string, body?: unknown) => Promise<CrudResponse>;
  seen: { url: string; init?: RequestInit | undefined }[];
} {
  const seen: { url: string; init?: RequestInit | undefined }[] = [];
  const client = createHttpCrudClient({
    baseUrl: BASE,
    credential: TEST_CREDENTIAL,
    fetch: (input, init) => {
      const url = urlOf(input);
      seen.push({ url, init });
      return Promise.resolve(answer(url, init));
    },
  });
  return { request: (path, body) => client.request('user-1', 'POST', path, body), seen };
}

function envelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the CRUD client', () => {
  it('sends the credential it was given and the body as JSON', async () => {
    const { request, seen } = clientAnswering(() => envelope(201, { id: 'w1' }));

    const response = await request('/watches', { url: 'https://shop.test' });

    expect(response).toEqual({ ok: true, status: 201, body: { id: 'w1' } });
    expect(seen[0]?.url).toBe('http://api.test/watches');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['cookie']).toBe('session=user-1');
    expect(seen[0]?.init?.body).toBe('{"url":"https://shop.test"}');
  });

  it('sends no body and no content type when there is nothing to send', async () => {
    const { request, seen } = clientAnswering(() => envelope(200, []));

    await request('/watches');

    expect(seen[0]?.init?.body).toBeUndefined();
    expect(seen[0]?.init?.headers).toEqual({ cookie: 'session=user-1' });
  });

  it('asks the credential for each caller and adds no identity of its own', async () => {
    // The regression this guards: a client that shipped its own identity header
    // let anything reaching the API claim to be anyone. One client serves every
    // chat, so the credential is asked per request rather than once.
    const asked: string[] = [];
    const seen: (Record<string, string> | undefined)[] = [];
    const client = createHttpCrudClient({
      baseUrl: BASE,
      credential: (caller) => {
        asked.push(caller);
        return { cookie: `session=${caller}` };
      },
      fetch: (_input, init) => {
        seen.push(init?.headers as Record<string, string> | undefined);
        return Promise.resolve(envelope(200, []));
      },
    });

    await client.request('user-1', 'GET', '/watches');
    await client.request('user-2', 'GET', '/watches');

    expect(asked).toEqual(['user-1', 'user-2']);
    expect(seen).toEqual([{ cookie: 'session=user-1' }, { cookie: 'session=user-2' }]);
    for (const headers of seen) expect(headers?.['x-user-id']).toBeUndefined();
  });

  it('does not double the slash when the base url has a trailing one', async () => {
    const seen: string[] = [];
    const client = createHttpCrudClient({
      baseUrl: 'http://api.test//',
      credential: TEST_CREDENTIAL,
      fetch: (input) => {
        seen.push(urlOf(input));
        return Promise.resolve(envelope(200, []));
      },
    });

    await client.request('user-1', 'GET', '/watches');

    expect(seen).toEqual(['http://api.test/watches']);
  });

  it('carries a validation refusal through with the field paths intact', async () => {
    const { request } = clientAnswering(() =>
      envelope(400, {
        error: {
          code: 'validation_failed',
          message: 'The request body is invalid.',
          details: [
            { path: '/url', message: 'must match format "http-url"' },
            { path: '', message: 'must NOT have additional properties' },
          ],
        },
      }),
    );

    const response = await request('/watches', {});

    expect(response).toEqual({
      ok: false,
      status: 400,
      // The empty pointer is the body itself, and `(body)` is what a reader can
      // act on; a bare colon would read as a missing field name.
      reason:
        'The request body is invalid. (/url: must match format "http-url"; ' +
        '(body): must NOT have additional properties)',
    });
  });

  it('carries a refusal that has no details as just its message', async () => {
    const { request } = clientAnswering(() =>
      envelope(404, { error: { code: 'not_found', message: 'No watch w9 belongs to you.' } }),
    );

    await expect(request('/watches/w9')).resolves.toEqual({
      ok: false,
      status: 404,
      reason: 'No watch w9 belongs to you.',
    });
  });

  it('says what it actually got when the refusal is not an envelope at all', async () => {
    // A proxy, a load balancer, a crash before Fastify's error handler: the
    // client must not pretend to have a reason it was never given.
    const { request } = clientAnswering(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const response = await request('/watches', {});

    expect(response.ok).toBe(false);
    expect(response.ok ? '' : response.reason).toContain('502');
    expect(response.ok ? '' : response.reason).toContain('Bad Gateway');
  });

  it('reports an unreachable server as a refusal rather than throwing at the model', async () => {
    const client = createHttpCrudClient({
      baseUrl: BASE,
      credential: TEST_CREDENTIAL,
      fetch: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const response = await client.request('user-1', 'GET', '/watches');

    expect(response.ok).toBe(false);
    // Status 0 rather than a made-up 5xx: nothing answered, so there is no
    // status to report, and a fabricated one would be a lie in a log.
    expect(response.ok ? -1 : response.status).toBe(0);
    expect(response.ok ? '' : response.reason).toContain('ECONNREFUSED');
  });

  it('treats an empty success body as nothing rather than as a parse failure', async () => {
    // `null`, not `''`: 204 is a null-body status, and the Response constructor
    // refuses a body for one. A server sends this shape; so must the stub.
    const { request } = clientAnswering(() => new Response(null, { status: 204 }));

    await expect(request('/watches/w1')).resolves.toEqual({ ok: true, status: 204, body: null });
  });

  it('keeps a non-JSON success body as the text it was', async () => {
    const { request } = clientAnswering(() => new Response('pong', { status: 200 }));

    await expect(request('/health')).resolves.toEqual({ ok: true, status: 200, body: 'pong' });
  });
});
