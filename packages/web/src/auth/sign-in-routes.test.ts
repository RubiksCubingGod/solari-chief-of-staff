import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiUnreachableError } from '../api-client';
import { POST as requestLink } from '../app/login/request/route';
import { POST as logout } from '../app/logout/route';
import { REQUEST_LINK_PATH, SESSION_COOKIE_NAME } from './session';

/**
 * The two same-origin handlers the sign-in form and the sign-out button post
 * to.
 *
 * They exist so the browser never has to make a cross-origin write: the page
 * talks to the app it is already on, and the app talks to the API. That makes
 * them thin, and what is worth proving about a thin thing is what it refuses to
 * do - leak whether an address has an account, and invent an answer the API
 * never gave.
 */

const API_BASE_URL = 'http://api.test';
const ORIGIN = 'https://dashboard.test';

interface Recorded {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string | undefined;
  readonly cookie: string | undefined;
}

function stubApi(respond: () => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
      cookie: headers['cookie'],
    });
    return Promise.resolve(respond());
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function submit(fields: Record<string, string>, origin: string = ORIGIN): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request(`${origin}/login/request`, { method: 'POST', body: form });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /login/request', () => {
  it('asks the API for a link and sends the browser to the confirmation', async () => {
    const calls = stubApi(() => json({ status: 'accepted' }, 202));

    const response = await requestLink(submit({ email: '  Owner@example.test  ' }));

    expect(calls[0]?.url).toBe(`${API_BASE_URL}/auth/request-link`);
    expect(calls[0]?.method).toBe('POST');
    // Trimmed, because a copied address arrives with whitespace on it and a
    // 400 for a trailing space is a form that looks broken.
    expect(calls[0]?.body).toBe('{"email":"Owner@example.test"}');
    // 303 so the browser follows with a GET: refreshing the confirmation
    // reloads a page rather than re-posting the form.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?sent=1');
  });

  it('answers a refusal from the API with the same confirmation', async () => {
    const calls = stubApi(() =>
      json({ error: { code: 'validation_failed', message: 'bad address' } }, 400),
    );

    const response = await requestLink(submit({ email: 'not-an-address' }));

    // The API answers a known and an unknown address identically; a page that
    // turned a refusal into "no such address" would hand back exactly the
    // answer the API withheld.
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/login?sent=1');
  });

  it('answers an empty form the same way without asking the API anything', async () => {
    const calls = stubApi(() => json({ status: 'accepted' }, 202));

    for (const form of [submit({ email: '   ' }), submit({})]) {
      const response = await requestLink(form);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login?sent=1');
    }

    expect(calls).toEqual([]);
  });

  it('does not swallow an API that never answered', async () => {
    vi.stubEnv('API_BASE_URL', API_BASE_URL);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    // A refusal is a decision worth hiding. An outage is not a decision, and
    // telling somebody their link is on its way when nothing was sent is a bug
    // that looks exactly like a working system.
    await expect(requestLink(submit({ email: 'owner@example.test' }))).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });

  it('sends the browser to a place that cannot move it off the host it dialled', async () => {
    stubApi(() => json({ status: 'accepted' }, 202));

    const dialled = await requestLink(submit({ email: 'owner@example.test' }));
    const elsewhere = await requestLink(
      submit({ email: 'owner@example.test' }, 'http://127.0.0.1:3000'),
    );

    // Relative, and identical whichever host asked, which is the property and
    // not an accident of formatting. `request.url` reports the host the server
    // believes it is rather than the one the browser typed - `localhost` for a
    // browser on `127.0.0.1` - so an absolute `Location` built from it hands
    // the reader a different origin, and a host-only session cookie does not
    // follow them there. The watches page found this by being the first
    // redirect whose destination needed the session: a pause landed the
    // browser at `/login`, signed out, one hop after signing in.
    expect(dialled.headers.get('location')).toBe('/login?sent=1');
    expect(elsewhere.headers.get('location')).toBe(dialled.headers.get('location'));
  });
});

describe('POST /logout', () => {
  const cleared = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  function signOut(cookie?: string, origin: string = ORIGIN): Request {
    return new Request(`${origin}/logout`, {
      method: 'POST',
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    });
  }

  it('asks the API to end the session and passes its cookie back verbatim', async () => {
    const calls = stubApi(
      () => new Response(null, { status: 303, headers: { 'set-cookie': cleared } }),
    );

    const response = await logout(signOut(`${SESSION_COOKIE_NAME}=signed.value`));

    expect(calls[0]?.url).toBe(`${API_BASE_URL}/auth/logout`);
    expect(calls[0]?.cookie).toBe(`${SESSION_COOKIE_NAME}=signed.value`);
    // Verbatim: the cookie carries no `Domain` and so is host-only, which makes
    // the header that clears it on the API's origin the same header that clears
    // it here. Rewriting it would be this app guessing at attributes it did not
    // choose.
    expect(response.headers.get('set-cookie')).toBe(cleared);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(REQUEST_LINK_PATH);
  });

  it('still lands on the sign-in page when the API set no cookie', async () => {
    stubApi(() => new Response(null, { status: 303 }));

    const response = await logout(signOut());

    // Nothing to clear is not a failure: a logout that refused a request
    // carrying nothing would strand exactly the person it is meant to help.
    expect(response.status).toBe(303);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('location')).toBe(REQUEST_LINK_PATH);
  });

  it('sends the browser to a place that cannot move it off the host it dialled', async () => {
    stubApi(() => new Response(null, { status: 303 }));

    const dialled = await logout(signOut());
    const elsewhere = await logout(signOut(undefined, 'http://127.0.0.1:3000'));

    // Same reason as the sign-in form, and worth pinning separately: this is
    // the redirect a signed-out browser follows, so an origin swap here would
    // strand it on a host nothing outside the server can necessarily reach.
    expect(dialled.headers.get('location')).toBe(REQUEST_LINK_PATH);
    expect(elsewhere.headers.get('location')).toBe(dialled.headers.get('location'));
  });
});
