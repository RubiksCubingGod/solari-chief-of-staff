import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as pause } from '../app/watches/pause/route';
import { SESSION_COOKIE_NAME } from '../auth/session';

/**
 * The pause control's handler, proven here rather than only in the browser.
 *
 * `watches-page.integration.test.ts` drives this route for real - a click, a
 * redirect, a re-read that shows the new status - and that is the proof that it
 * works. What a browser cannot show is what the route refuses: a form that
 * arrives without an id, or naming a status the domain does not have, must not
 * become a request to the API, and there is no way to make a browser send one.
 *
 * The route also runs in the dashboard's own process rather than the test's, so
 * nothing the e2e exercises is instrumented. These are the assertions that
 * survive somebody deleting a guard.
 */

const API_BASE_URL = 'http://api.test';
const WATCH_ID = 'watch-1';
const SESSION = `${SESSION_COOKIE_NAME}=signed.value`;

interface Recorded {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: string | undefined;
  readonly cookie: string | undefined;
}

function stubApi(): Recorded[] {
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
    return Promise.resolve(
      new Response(JSON.stringify({ id: WATCH_ID }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return calls;
}

/** The form the page posts, optionally without the session the page has. */
function submit(fields: Record<string, string>, cookie: string | null = SESSION): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new Request('https://dashboard.test/watches/pause', {
    method: 'POST',
    body: form,
    ...(cookie === null ? {} : { headers: { cookie } }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /watches/pause', () => {
  it('asks the API to set the status it was given, carrying the session unread', async () => {
    const calls = stubApi();

    const response = await pause(submit({ id: WATCH_ID, status: 'paused' }));

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/watches/${WATCH_ID}`);
    expect(calls[0]?.body).toBe('{"status":"paused"}');
    // Forwarded verbatim: this route never reads the session, which is what
    // makes it unable to act as anyone other than whoever is holding it. The
    // API settles ownership and answers a stranger's watch as a missing one.
    expect(calls[0]?.cookie).toBe(SESSION);
    expect(response.status).toBe(303);
  });

  it('starts a watch again through the same door', async () => {
    const calls = stubApi();

    await pause(submit({ id: WATCH_ID, status: 'active' }));

    expect(calls[0]?.body).toBe('{"status":"active"}');
  });

  it('escapes an id that would otherwise reach for another path', async () => {
    const calls = stubApi();

    await pause(submit({ id: 'a/b', status: 'paused' }));

    // An id is not a path segment until it is escaped. Unescaped, a form field
    // chooses which API endpoint this route calls.
    expect(calls[0]?.url).toBe(`${API_BASE_URL}/watches/a%2Fb`);
  });

  it('asks the API nothing when the form names a status the domain does not have', async () => {
    const calls = stubApi();

    const response = await pause(submit({ id: WATCH_ID, status: 'deleted' }));

    // The guard is `isWatchStatus`, so the set of values this route can send is
    // the domain's own rather than whatever a form happens to contain.
    expect(calls).toEqual([]);
    expect(response.status).toBe(303);
  });

  it('asks the API nothing when the form carries no watch at all', async () => {
    const calls = stubApi();

    for (const form of [submit({ status: 'paused' }), submit({ id: WATCH_ID })]) {
      const response = await pause(form);
      expect(response.status).toBe(303);
    }

    expect(calls).toEqual([]);
  });

  it('sends an unauthenticated post on to the API rather than deciding for it', async () => {
    const calls = stubApi();

    await pause(submit({ id: WATCH_ID, status: 'paused' }, null));

    // No cookie is not this route's refusal to make. It forwards an empty
    // credential and the API answers 401, which is the same answer every other
    // door gives - one place decides who is signed in, and it is not here.
    expect(calls[0]?.cookie).toBe('');
  });

  it('sends the browser back to the list on a host it can still be signed in on', async () => {
    stubApi();

    const dialled = await pause(submit({ id: WATCH_ID, status: 'paused' }));

    // Relative, so the browser stays on the origin it chose. `request.url`
    // reports the host the server thinks it is, and following it would move a
    // browser on `127.0.0.1` to `localhost`, leaving a host-only session cookie
    // behind - which is exactly how this landed at `/login`, signed out, the
    // first time the e2e ran it.
    expect(dialled.headers.get('location')).toBe('/watches');
  });
});
