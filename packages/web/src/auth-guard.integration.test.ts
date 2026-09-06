import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REQUEST_LINK_PATH, SESSION_COOKIE_NAME } from './auth/session';
import { startWebDevServer, type WebDevServer } from './testing/dev-server';

/**
 * The guard, proven the way a person meets it: in a browser, against the real
 * dashboard and the real API, with a link that was really issued and a cookie
 * the page cannot read.
 *
 * A browser rather than `fetch` alone because two of the properties here only
 * exist in one. The session cookie is set by the API on one loopback port and
 * spent by the dashboard on another - it works because a cookie with no
 * `Domain` is scoped to the host and ports are not part of that, which is a
 * rule a cookie jar implements and a `fetch` call in a test would only be
 * asserting about itself. And `HttpOnly` is not observable at all without a
 * document to run script in.
 */

/**
 * The fixture the API package builds: a server, a migrated database and one
 * account, as a handle. Restated here rather than imported as a type because
 * this file is compiled by `packages/web/tsconfig.json`, which - deliberately -
 * cannot resolve anything outside the dashboard.
 */
interface AuthStack {
  readonly url: string;
  readonly userId: string;
  readonly email: string;
  lastLink(): string | undefined;
  clearMail(): void;
  stop(): Promise<void>;
}

interface AuthStackModule {
  startAuthStack(options: { readonly dashboardBaseUrl: string }): Promise<AuthStack>;
  reserveLoopbackPort(): Promise<number>;
}

/**
 * Loaded through a variable rather than a literal, on purpose.
 *
 * `eslint.config.js` keeps `packages/web` away from `@chief-of-staff/db` and
 * everything under it, and this package's TypeScript project resolves like the
 * bundler that builds it - no workspace paths, no source aliases. A written-out
 * specifier here would therefore fail the type check even though the module it
 * names is aliased for the test runner and resolves perfectly at run time. The
 * indirection is what keeps the boundary honest: the dashboard's own source
 * still names nothing but HTTP, and only its test reaches for the server that
 * serves it.
 */
const AUTH_STACK_MODULE = '@chief-of-staff/api/testing';

/** Every dashboard path that must be behind the guard. */
const GUARDED_PATHS = ['/', '/watches', '/calendar', '/tasks'] as const;

let stack: AuthStack;
let web: WebDevServer;
let browser: Browser;

beforeAll(async () => {
  const module = (await import(AUTH_STACK_MODULE)) as AuthStackModule;
  // The two servers name each other: the API builds its redirects out of a
  // configured dashboard origin, and the dashboard reads the API's origin out
  // of its environment. One of them has to have a known address first, so the
  // dashboard's port is reserved before either starts.
  const port = await module.reserveLoopbackPort();
  const dashboardBaseUrl = `http://127.0.0.1:${String(port)}`;

  stack = await module.startAuthStack({ dashboardBaseUrl });
  web = await startWebDevServer({ apiBaseUrl: stack.url, port });
  expect(web.url).toBe(dashboardBaseUrl);
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser.close();
  await web.stop();
  await stack.stop();
});

/** What the browser was handed, without following it. */
async function fetchWithoutFollowing(
  path: string,
  cookie?: string,
): Promise<{ status: number; location: string | undefined; body: string }> {
  const response = await fetch(`${web.url}${path}`, {
    redirect: 'manual',
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  const location = response.headers.get('location');
  return {
    status: response.status,
    location: location === null ? undefined : new URL(location, web.url).pathname,
    body: await response.text(),
  };
}

/** Asks for a link the way a person does, and hands back the one that was mailed. */
async function askForLink(page: Page, address: string): Promise<string | undefined> {
  stack.clearMail();
  await page.goto(`${web.url}${REQUEST_LINK_PATH}`);
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: /sign-in link/iu }).click();
  await page.waitForURL(/\/login\?sent=1$/u);
  return stack.lastLink();
}

async function withPage<T>(run: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  // A context per test rather than a shared one, so a session left behind by
  // one test cannot be what makes the next one pass.
  const context = await browser.newContext();
  try {
    return await run(await context.newPage(), context);
  } finally {
    await context.close();
  }
}

describe('the dashboard guard', () => {
  it('sends an unauthenticated request for any dashboard page to the sign-in page', async () => {
    for (const path of GUARDED_PATHS) {
      const response = await fetchWithoutFollowing(path);

      // The status and the destination, with whatever came back instead in the
      // message: a guard that fails is almost always a guard that threw, and
      // the error is the only thing that says why.
      expect(response.status, `${path} answered:\n${response.body.slice(0, 4000)}`).toBe(307);
      expect(response.location, path).toBe(REQUEST_LINK_PATH);
    }
  });

  it('leaves the sign-in page itself reachable, or nobody could ever get in', async () => {
    const response = await fetchWithoutFollowing(REQUEST_LINK_PATH);

    expect(response.status, response.body.slice(0, 4000)).toBe(200);
    expect(response.body).toContain('Email me a sign-in link');
    // The shell renders for a signed-out visitor too, and says nothing about
    // anybody.
    expect(response.body).toContain('Chief of Staff');
    expect(response.body).not.toContain('Signed in as');
  });

  it('treats a cookie it cannot verify as unauthenticated rather than as an error', async () => {
    for (const cookie of [
      `${SESSION_COOKIE_NAME}=nonsense`,
      // Shaped like a session, signed by nobody.
      `${SESSION_COOKIE_NAME}=eyJ1aWQiOiJ4In0.not-a-signature`,
      `${SESSION_COOKIE_NAME}=`,
      'something-else=value',
    ]) {
      const response = await fetchWithoutFollowing('/', cookie);

      // A redirect, not a 500 and not a stack trace: a browser holding a stale
      // cookie is a browser that needs to sign in again, not an incident.
      expect(response.status, `${cookie} answered:\n${response.body.slice(0, 4000)}`).toBe(307);
      expect(response.location, cookie).toBe(REQUEST_LINK_PATH);
    }
  });

  it(
    'takes a person from a guarded page through the emailed link into the dashboard',
    async () =>
      withPage(async (page, context) => {
        // Arrives at a dashboard page and is turned away.
        await page.goto(`${web.url}/watches`);
        expect(new URL(page.url()).pathname).toBe(REQUEST_LINK_PATH);

        const link = await askForLink(page, stack.email);
        expect(link).toBeDefined();
        // The link points at the API, which is a different origin to the page
        // that asked for it. That is the whole arrangement being tested.
        expect(link?.startsWith(`${stack.url}/auth/callback?token=`)).toBe(true);
        expect(await page.getByRole('status').textContent()).toContain('on its way');

        await page.goto(link ?? '');

        // Landed on the dashboard, signed in, with a cookie the API set on one
        // port being spent by a page served from another.
        expect(page.url().startsWith(web.url)).toBe(true);
        expect(new URL(page.url()).pathname).toBe('/');
        expect(await page.locator('body').textContent()).toContain(`Signed in as ${stack.email}`);

        const [session] = (await context.cookies()).filter(
          (cookie) => cookie.name === SESSION_COOKIE_NAME,
        );
        expect(session).toBeDefined();
        expect(session?.httpOnly).toBe(true);
        expect(session?.path).toBe('/');
        expect(session?.sameSite).toBe('Lax');

        // And the guarded page it was originally trying to reach is served
        // rather than redirected.
        await page.goto(`${web.url}/watches`);
        expect(new URL(page.url()).pathname).toBe('/watches');
      }),
    240_000,
  );

  it(
    'keeps the session out of reach of any script on the page',
    async () =>
      withPage(async (page, context) => {
        const link = await askForLink(page, stack.email);
        await page.goto(link ?? '');
        expect(await page.locator('body').textContent()).toContain('Signed in as');

        // The page is signed in, and cannot read what signs it in. An XSS bug
        // in a later section must not also be an account takeover.
        const readable = await page.evaluate(() => document.cookie);
        expect(readable).not.toContain(SESSION_COOKIE_NAME);
        expect(
          (await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE_NAME),
        ).toBe(true);
      }),
    240_000,
  );

  it(
    'ends the session on sign out and guards the dashboard again',
    async () =>
      withPage(async (page, context) => {
        const link = await askForLink(page, stack.email);
        await page.goto(link ?? '');
        expect(await page.locator('body').textContent()).toContain('Signed in as');

        await page.getByRole('button', { name: 'Sign out' }).click();
        await page.waitForURL(/\/login$/u);

        // The cookie is gone from the browser, not merely ignored by the server.
        expect(
          (await context.cookies()).some(
            (cookie) => cookie.name === SESSION_COOKIE_NAME && cookie.value !== '',
          ),
        ).toBe(false);

        await page.goto(`${web.url}/watches`);
        expect(new URL(page.url()).pathname).toBe(REQUEST_LINK_PATH);
      }),
    240_000,
  );

  it(
    'refuses a link that has already been followed and says so on the sign-in page',
    async () => {
      const link = await withPage(async (page) => {
        const issued = await askForLink(page, stack.email);
        await page.goto(issued ?? '');
        expect(await page.locator('body').textContent()).toContain('Signed in as');
        return issued;
      });

      // A second browser, with no session of its own, following the same link.
      await withPage(async (page, context) => {
        await page.goto(link ?? '');

        expect(new URL(page.url()).pathname).toBe(REQUEST_LINK_PATH);
        expect(new URL(page.url()).searchParams.get('error')).toBe('invalid_link');
        // The page's own alert, not Next's route announcer, which is a second
        // empty role=alert once the page has hydrated.
        const alert = page.getByRole('alert').filter({ hasText: /link/u });
        expect(await alert.textContent()).toContain('already been used');
        // Refused all the way down: nothing was issued to the browser that
        // presented a spent link.
        expect(
          (await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE_NAME),
        ).toBe(false);
      });
    },
    240_000,
  );

  it(
    'answers a request for an address nobody holds exactly as it answers a real one',
    async () =>
      withPage(async (page) => {
        const known = await askForLink(page, stack.email);
        expect(known).toBeDefined();
        const confirmation = await page.getByRole('status').textContent();

        const unknown = await askForLink(page, 'nobody@example.test');

        // The same sentence, and nothing sent behind it. A dashboard that said
        // "no account for that address" would be an account enumerator with a
        // form on it.
        expect(await page.getByRole('status').textContent()).toBe(confirmation);
        expect(unknown).toBeUndefined();
        // Still signed out: asking for a link is not a way in by itself.
        const guarded = await fetchWithoutFollowing('/');
        expect(guarded.location).toBe(REQUEST_LINK_PATH);
      }),
    240_000,
  );
});
