import { describe, expect, it } from 'vitest';

import {
  ApiError,
  ApiUnreachableError,
  UNKNOWN_ERROR_CODE,
  sessionCookieCredential,
  type FetchLike,
} from '../api-client';
import { createConnectClient, type ConnectClient } from './client';

/**
 * The connect client's reading of what the API sends back. The route proofs
 * cover a well-formed refusal; this covers the other kind - a proxy's HTML
 * page, a body that is JSON but not an envelope, an envelope with no details -
 * which the client has to report as an unrecognised refusal carrying the
 * status, never as a crash on the one button the reader pressed.
 */

const BASE_URL = 'http://api.test';
const COOKIE = 'session=signed.value';

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers every call the same way and remembers what it was asked. */
function answering(status: number, body: string | null): FetchLike & { readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const send: FetchLike = (url, init) => {
    sent.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  };
  return Object.assign(send, { sent });
}

function clientOver(fetch: FetchLike): ConnectClient {
  return createConnectClient({ baseUrl: BASE_URL, credential: sessionCookieCredential(COOKIE), fetch });
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error(`expected an ApiError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the API to refuse');
}

describe('createConnectClient', () => {
  it('asks as the session and hands back what the API said', async () => {
    const connection = { id: 'conn-1', siteDomain: 'gym.example.test', status: 'connected', lastUsedAt: null };
    const fetch = answering(200, JSON.stringify([connection]));

    const connections = await clientOver(fetch).listConnections();

    expect(connections).toEqual([connection]);
    expect(fetch.sent[0]?.url).toBe(`${BASE_URL}/site-connections`);
    expect(fetch.sent[0]?.init).toMatchObject({ method: 'GET', headers: { accept: 'application/json', cookie: COOKIE } });
  });

  it('escapes an attempt id before putting it in a path', async () => {
    const fetch = answering(200, JSON.stringify({ id: 'a/b', status: 'started' }));

    await clientOver(fetch).readAttempt('a/b');

    expect(fetch.sent[0]?.url).toBe(`${BASE_URL}/site-connections/attempts/a%2Fb`);
  });

  it('cancels with a DELETE and expects nothing back', async () => {
    const fetch = answering(204, null);

    await expect(clientOver(fetch).cancelAttempt('attempt-1')).resolves.toBeUndefined();

    expect(fetch.sent[0]?.init?.method).toBe('DELETE');
  });

  it('reads a refusal the API described, details and all', async () => {
    const detail = { path: 'siteDomain', message: 'is not a host' };
    const fetch = answering(
      400,
      JSON.stringify({ error: { code: 'validation_failed', message: 'siteDomain is not a host', details: [detail] } }),
    );

    const error = await refusal(clientOver(fetch).startAttempt('not a host'));

    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('siteDomain is not a host');
    expect(error.details).toEqual([detail]);
  });

  it('reads a refusal without details as one with none', async () => {
    const fetch = answering(404, JSON.stringify({ error: { code: 'not_found', message: 'That attempt is not open.' } }));

    const error = await refusal(clientOver(fetch).confirmAttempt('attempt-1'));

    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.details).toEqual([]);
  });

  it.each([
    { what: 'a body that is not JSON', body: '<html>502 Bad Gateway</html>' },
    { what: 'a JSON null', body: 'null' },
    { what: 'a JSON body that is not an object', body: '"refused"' },
    { what: 'an object with no error in it', body: '{"message":"refused"}' },
    { what: 'an error that is not an object', body: '{"error":"refused"}' },
    { what: 'an error that is null', body: '{"error":null}' },
    { what: 'an error with no code', body: '{"error":{"message":"refused"}}' },
    { what: 'an error with no message', body: '{"error":{"code":"bad_gateway","message":502}}' },
  ])('reports $what as an unrecognised refusal carrying the status', async ({ body }) => {
    const fetch = answering(502, body);

    const error = await refusal(clientOver(fetch).readAttempt('attempt-1'));

    expect(error.status).toBe(502);
    expect(error.code).toBe(UNKNOWN_ERROR_CODE);
    expect(error.details).toEqual([]);
    expect(error.message).toBe('GET /site-connections/attempts/attempt-1 was refused with 502 and no error envelope.');
  });

  it('says the API did not answer when fetch itself fails', async () => {
    const away: FetchLike = () => Promise.reject(new TypeError('fetch failed'));

    await expect(clientOver(away).listConnections()).rejects.toBeInstanceOf(ApiUnreachableError);
  });
});
