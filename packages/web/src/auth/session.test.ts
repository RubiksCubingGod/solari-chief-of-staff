import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiUnreachableError } from '../api-client';
import { REQUEST_LINK_PATH, SESSION_COOKIE_NAME, readSession } from './session';

/**
 * The guard's one decision, taken apart.
 *
 * `auth-guard.integration.test.ts` proves this against a real API in a real
 * browser; what is worth isolating here is the branch nothing observable
 * distinguishes - "the API said no" and "the API said nothing" both leave the
 * caller without a session, and only one of them is a reason to let them in
 * nowhere at all.
 */

const API_BASE_URL = 'http://api.test';
const SESSION = `${SESSION_COOKIE_NAME}=signed.value`;
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };

interface StubbedFetch {
  readonly calls: { url: string; cookie: string | undefined }[];
}

function stubApi(respond: () => Response | Promise<Response>): StubbedFetch {
  const calls: { url: string; cookie: string | undefined }[] = [];
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, cookie: headers['cookie'] });
    return Promise.resolve(respond());
  });
  return { calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('readSession', () => {
  it('answers a request carrying no session without asking the API', async () => {
    const stub = stubApi(() => json(USER));

    await expect(readSession(undefined)).resolves.toBeUndefined();
    await expect(readSession('theme=dark; other=1')).resolves.toBeUndefined();

    // Most requests are this request. Asking the API to confirm the absence of
    // a cookie this process can already see is absent buys nothing and costs a
    // round trip on every asset a signed-out browser pulls.
    expect(stub.calls).toEqual([]);
  });

  it('asks the API who the cookie speaks for and answers with what it said', async () => {
    const stub = stubApi(() => json(USER));

    await expect(readSession(`theme=dark; ${SESSION}`)).resolves.toEqual(USER);

    expect(stub.calls[0]?.url).toBe(`${API_BASE_URL}/auth/session`);
    // Verbatim, unrelated cookies included: this package holds no key and could
    // not verify or trim the header if it wanted to.
    expect(stub.calls[0]?.cookie).toBe(`theme=dark; ${SESSION}`);
  });

  it('reads an emptied cookie as no session rather than as no cookie', async () => {
    // What a browser holds immediately after signing out.
    const stub = stubApi(() =>
      json({ error: { code: 'unauthorized', message: 'no session' } }, 401),
    );

    await expect(readSession(`${SESSION_COOKIE_NAME}=`)).resolves.toBeUndefined();

    // The API is still the one that decided, because an empty value is a claim
    // about a cookie and only the API can price it.
    expect(stub.calls).toHaveLength(1);
  });

  it('turns a refusal into "not signed in" and nothing else', async () => {
    stubApi(() => json({ error: { code: 'unauthorized', message: 'no session' } }, 401));

    await expect(readSession(SESSION)).resolves.toBeUndefined();
  });

  it('refuses to guess when the API failed rather than refused', async () => {
    stubApi(() => json({ error: { code: 'internal_error', message: 'boom' } }, 500));

    // Not `undefined`: the API has not said this visitor is signed out, it has
    // said nothing. Reporting that as "signed out" would send everybody to a
    // sign-in page that cannot work either, with no sign anywhere of what
    // actually broke.
    await expect(readSession(SESSION)).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses to guess when the API did not answer at all', async () => {
    vi.stubEnv('API_BASE_URL', API_BASE_URL);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    await expect(readSession(SESSION)).rejects.toBeInstanceOf(ApiUnreachableError);
  });

  it('names the page an unauthenticated visitor is sent to', () => {
    // Shared with the middleware and with the API's own redirects, so a rename
    // that missed one of them would be a redirect loop.
    expect(REQUEST_LINK_PATH).toBe('/login');
    expect(SESSION_COOKIE_NAME).toBe('cos_session');
  });
});
