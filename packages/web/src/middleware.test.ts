import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REQUEST_LINK_PATH, SESSION_COOKIE_NAME } from './auth/session';
import { config, middleware } from './middleware';

/**
 * The guard, on its own.
 *
 * `auth-guard.integration.test.ts` puts a browser through the whole flow; what
 * this adds is the part of the guard that is a decision rather than a journey -
 * which paths it claims, and what it does with each answer `readSession` can
 * give. The matcher in particular is worth an assertion of its own: it is a
 * regular expression whose failure mode is silence, and a section that quietly
 * stopped being guarded looks exactly like a section that works.
 */

const API_BASE_URL = 'http://api.test';
const SESSION = `${SESSION_COOKIE_NAME}=signed.value`;

function stubApi(status: number, body: unknown): void {
  vi.stubEnv('API_BASE_URL', API_BASE_URL);
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new Request(`https://dashboard.test${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  }));
}

/** The matcher as Next reads it: one pattern, anchored over the whole path. */
function claims(path: string): boolean {
  return config.matcher.some((pattern) => new RegExp(`^${pattern}$`, 'u').test(path));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the dashboard middleware', () => {
  it('lets a request with a session through untouched', async () => {
    stubApi(200, { id: 'user-1', email: 'owner@example.test' });

    const response = await middleware(request('/watches', SESSION));

    // `NextResponse.next()` is a 200 carrying an instruction, not a page: the
    // request goes on to whatever would have handled it.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('sends a request without one to the sign-in page', async () => {
    stubApi(401, { error: { code: 'unauthorized', message: 'no session' } });

    const response = await middleware(request('/watches'));

    expect(response.status).toBe(307);
    // Absolute, and on the origin the request arrived at rather than a
    // configured one, so the redirect works behind any host the app is served
    // from.
    expect(response.headers.get('location')).toBe(
      `https://dashboard.test${REQUEST_LINK_PATH}`,
    );
  });

  it('sends a request carrying a cookie the API refuses to the same place', async () => {
    stubApi(401, { error: { code: 'unauthorized', message: 'no session' } });

    const response = await middleware(request('/', `${SESSION_COOKIE_NAME}=nonsense`));

    // A redirect, not an error page. A browser holding a stale cookie needs to
    // sign in again; it has not done anything wrong.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `https://dashboard.test${REQUEST_LINK_PATH}`,
    );
  });

  it('lets a request past when the API cannot be asked, rather than looping it', async () => {
    vi.stubEnv('API_BASE_URL', API_BASE_URL);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));

    const response = await middleware(request('/watches', SESSION));

    // The page behind this guard renders "the API did not answer". A redirect
    // would replace that sentence with the sign-in page, which needs the same
    // API to send a link - a reader would be bounced to a dead end and told
    // they were signed out, when what happened is that a server is down.
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('claims every dashboard path, including ones no task has built yet', () => {
    // The default is "guarded". A section added after this task is covered by
    // this matcher on the day it is created, without anybody remembering to say
    // so - which is the direction a security default has to point.
    for (const path of ['/', '/watches', '/calendar', '/tasks', '/something/new']) {
      expect(claims(path), path).toBe(true);
    }
  });

  it('leaves out exactly the four things that would break if it did not', () => {
    for (const path of [
      // The framework's own output, which carries nothing about anybody.
      '/_next/static/chunks/main.js',
      // Or an unauthenticated visitor would be redirected to the page they are
      // already being redirected to.
      REQUEST_LINK_PATH,
      '/login/request',
      // Which has to work for exactly the person whose session no longer
      // verifies, or the stale cookie stays in the browser for ever.
      '/logout',
      // Asked for before anybody has logged in.
      '/favicon.ico',
    ]) {
      expect(claims(path), path).toBe(false);
    }
  });

  it('asks for the Node runtime, because it reads a variable by name', () => {
    // The guard resolves the API's origin out of the environment. The edge
    // bundle only carries what the compiler saw asked for by name, and this is
    // the belt to that braces.
    expect(config.runtime).toBe('nodejs');
  });
});
