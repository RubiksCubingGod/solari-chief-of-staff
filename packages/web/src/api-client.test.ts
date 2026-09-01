import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  ApiError,
  ApiUnreachableError,
  UNKNOWN_ERROR_CODE,
  anonymousCredential,
  createApiClient,
  isApiErrorCode,
  sessionCookieCredential,
  type FetchLike,
} from './api-client';

/** The cookie the API issues, as a browser would present it. */
const SESSION = 'cos_session=signed.value';

const BASE_URL = 'https://api.example.com';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/**
 * A `fetch` that records what it was asked for and answers with what the test
 * says the server would say. Injected rather than patched onto the global, so
 * two tests in this file cannot see each other's stubbing.
 */
function stubFetch(
  respond: (call: RecordedCall) => Response | Promise<Response>,
): { readonly calls: RecordedCall[]; readonly fetch: FetchLike } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const call: RecordedCall = {
        url: input,
        method: init?.method ?? 'GET',
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('reads a list through the path the server publishes', async () => {
    const stub = stubFetch(() => json([{ id: 'watch-1', status: 'active' }]));
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    const watches = await client.listWatches();

    expect(watches).toEqual([{ id: 'watch-1', status: 'active' }]);
    expect(stub.calls[0]?.url).toBe(`${BASE_URL}/watches`);
    expect(stub.calls[0]?.method).toBe('GET');
  });

  it('asks the credential for headers on every call rather than capturing them once', async () => {
    let issued = 0;
    const stub = stubFetch(() => json([]));
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      credential: () => {
        issued += 1;
        return { headers: { cookie: `cos_session=session-${String(issued)}` } };
      },
    });

    await client.listCalendarItems();
    await client.listTasks();

    expect(issued).toBe(2);
    expect(stub.calls[0]?.headers['cookie']).toBe('cos_session=session-1');
    expect(stub.calls[1]?.headers['cookie']).toBe('cos_session=session-2');
    expect(stub.calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/calendar-items`,
      `${BASE_URL}/tasks`,
    ]);
  });

  it('awaits a credential that has to be fetched before it can be presented', async () => {
    const stub = stubFetch(() => json([]));
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      credential: () => Promise.resolve({ headers: { cookie: 'session=abc' } }),
    });

    await client.listWatches();

    expect(stub.calls[0]?.headers['cookie']).toBe('session=abc');
  });

  it('sends a write as JSON with the id escaped into the path', async () => {
    const stub = stubFetch(() => json({ id: 'a/b', status: 'paused' }));
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      credential: sessionCookieCredential(SESSION),
    });

    const updated = await client.setWatchStatus('a/b', 'paused');

    expect(updated.status).toBe('paused');
    expect(stub.calls[0]?.url).toBe(`${BASE_URL}/watches/a%2Fb`);
    expect(stub.calls[0]?.method).toBe('PATCH');
    expect(stub.calls[0]?.body).toBe('{"status":"paused"}');
    expect(stub.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('surfaces a refusal by its code and its details, not by its wording', async () => {
    const stub = stubFetch(() =>
      json(
        {
          error: {
            code: 'validation_failed',
            message: 'The request did not match the schema for this route.',
            details: [{ path: '/status', message: 'must be equal to one of the allowed values' }],
          },
        },
        400,
      ),
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    await expect(client.setWatchStatus('watch-1', 'paused')).rejects.toThrow(ApiError);
    const error = await client.setWatchStatus('watch-1', 'paused').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('validation_failed');
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).details).toEqual([
      { path: '/status', message: 'must be equal to one of the allowed values' },
    ]);
  });

  it('does not invent a code for a refusal that carried no envelope', async () => {
    // A proxy or a load balancer can refuse before the server sees the request,
    // and its body is HTML. Reporting that as some declared code would be a
    // guess a caller then branches on.
    const stub = stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    const error = await client.listTasks().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(UNKNOWN_ERROR_CODE);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).details).toEqual([]);
    expect(isApiErrorCode((error as ApiError).code)).toBe(false);
  });

  it('ignores an envelope whose error is not the published shape', async () => {
    const stub = stubFetch(() => json({ error: 'nope' }, 400));
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    const error = await client.listWatches().catch((cause: unknown) => cause);

    expect((error as ApiError).code).toBe(UNKNOWN_ERROR_CODE);
  });

  it('tells an unreachable API apart from one that refused', async () => {
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    const error = await client.health().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiUnreachableError);
    expect((error as ApiUnreachableError).url).toBe(`${BASE_URL}/health`);
    expect((error as ApiUnreachableError).cause).toBeInstanceOf(TypeError);
  });

  it('reads the health probe with no credential attached', async () => {
    const stub = stubFetch(() => json({ status: 'ok' }));
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    expect(await client.health()).toEqual({ status: 'ok' });
    expect(stub.calls[0]?.headers['cookie']).toBeUndefined();
    expect(anonymousCredential()).toEqual({ headers: {} });
  });

  it('forwards the browser cookie verbatim rather than interpreting it', async () => {
    const stub = stubFetch(() => json({ id: 'user-1', email: 'owner@example.test' }));
    const client = createApiClient({
      baseUrl: BASE_URL,
      fetch: stub.fetch,
      credential: sessionCookieCredential(`${SESSION}; other=kept`),
    });

    const user = await client.session();

    expect(user).toEqual({ id: 'user-1', email: 'owner@example.test' });
    expect(stub.calls[0]?.url).toBe(`${BASE_URL}/auth/session`);
    // Verbatim: the dashboard holds no key and so has no business rewriting a
    // credential it cannot verify. Dropping the unrelated cookie would also be
    // a decision the API is the one entitled to make.
    expect(stub.calls[0]?.headers['cookie']).toBe(`${SESSION}; other=kept`);
    expect(sessionCookieCredential(SESSION)()).toEqual({ headers: { cookie: SESSION } });
  });

  it('surfaces an unauthenticated session as a 401 refusal rather than an empty user', async () => {
    const stub = stubFetch(() =>
      json({ error: { code: 'unauthorized', message: 'no session' } }, 401),
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    const error: unknown = await client.session().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe('unauthorized');
    expect(isApiErrorCode('unauthorized')).toBe(true);
  });

  it('asks for a magic link without a credential and reads nothing back', async () => {
    const stub = stubFetch(() => json({ status: 'accepted' }, 202));
    const client = createApiClient({ baseUrl: BASE_URL, fetch: stub.fetch });

    await expect(client.requestLink('owner@example.test')).resolves.toBeUndefined();

    expect(stub.calls[0]?.url).toBe(`${BASE_URL}/auth/request-link`);
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.body).toBe('{"email":"owner@example.test"}');
    // Nobody is signed in yet, so nothing is presented.
    expect(stub.calls[0]?.headers['cookie']).toBeUndefined();
  });

  it('reaches the real global fetch when it is handed no other one', async () => {
    // The default matters: a client built without a `fetch` in a page is the
    // only shape that ever runs in production.
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:1' });

    await expect(client.health()).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});

describe('the published error codes', () => {
  it('recognises the codes the server declares and nothing else', () => {
    for (const code of API_ERROR_CODES) {
      expect(isApiErrorCode(code)).toBe(true);
    }
    expect(isApiErrorCode('teapot')).toBe(false);
  });
});
