import {
  BrowserProviderError,
  type BrowserProvider,
  type BrowserRequest,
  type BrowserSession,
  type SessionMeta,
} from '@chief-of-staff/solari';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BROWSER_TIMEOUT_MS, describeBrowserFailure, fetchBrowser } from './browser.js';

/**
 * The browser tiers against a scripted provider and page. What is fixed here
 * is the seam's contract as this package relies on it: what the tier asks the
 * provider for, what it sends the site, what it writes down afterwards - and
 * that the stealth it records is the provider's echo, never its own wish.
 */

type Page = Awaited<ReturnType<BrowserSession['newPage']>>;
type Response = NonNullable<Awaited<ReturnType<Page['goto']>>>;

const PAGE = '<html><body><main>Widget $19.99</main></body></html>';
const URL = 'http://shop.test/product/widget';

interface PageScript {
  readonly html?: string;
  readonly status?: number;
  /** `null` scripts a response with no content-type header at all. */
  readonly contentType?: string | null;
  readonly redirectedFrom?: boolean;
  readonly landsOn?: string;
  readonly noResponse?: boolean;
  readonly failWith?: unknown;
}

interface Seen {
  readonly requests: BrowserRequest[];
  headers: Record<string, string> | undefined;
  releases: number;
}

function fakePage(script: PageScript, seen: Seen): Page {
  let current = 'about:blank';
  const page = {
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
      seen.headers = headers;
      return Promise.resolve();
    },
    goto(url: string): Promise<Response | null> {
      current = script.landsOn ?? url;
      if (script.failWith !== undefined) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the tier must survive whatever a browser throws
        return Promise.reject(script.failWith);
      }
      if (script.noResponse === true) return Promise.resolve(null);
      const response = {
        status: () => script.status ?? 200,
        headers: () =>
          script.contentType === null ? {} : { 'content-type': script.contentType ?? 'text/html; charset=utf-8' },
        request: () => ({ redirectedFrom: () => (script.redirectedFrom === true ? {} : null) }),
      } as unknown as Response;
      return Promise.resolve(response);
    },
    content: () => Promise.resolve(script.html ?? PAGE),
    url: () => current,
  };
  return page as unknown as Page;
}

interface ProviderScript {
  /** What the provider says it applied, whatever was asked. */
  readonly stealthEcho?: boolean;
  readonly acquireFails?: BrowserProviderError;
}

function fakeProvider(page: PageScript, seen: Seen, script: ProviderScript = {}): BrowserProvider {
  return {
    name: 'fake',
    acquire(request: BrowserRequest = {}) {
      seen.requests.push(request);
      if (script.acquireFails !== undefined) return Promise.reject(script.acquireFails);
      const meta: SessionMeta = {
        sessionId: `fake-${String(seen.requests.length)}`,
        stealth: script.stealthEcho ?? false,
        captcha: false,
        recording: false,
        proxy: undefined,
        timezoneId: undefined,
        profileId: undefined,
        storageState: undefined,
        expiresAt: undefined,
      };
      const session: BrowserSession = {
        meta,
        context: {} as BrowserSession['context'],
        released: false,
        newPage: () => Promise.resolve(fakePage(page, seen)),
        release: () => {
          seen.releases += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
    liveSessionIds: () => [],
    dispose: () => Promise.resolve(),
  };
}

function seen(): Seen {
  return { requests: [], headers: undefined, releases: 0 };
}

describe('fetchBrowser', () => {
  it('tier 1 asks for a plain session, sends nothing extra, and records what came back', async () => {
    const log = seen();
    const provider = fakeProvider({ status: 200 }, log);

    const attempt = await fetchBrowser(URL, { provider, tier: 'browser' });

    expect(log.requests).toEqual([{}]);
    expect(log.headers).toBeUndefined();
    expect(attempt).toMatchObject({
      ok: true,
      tier: 'browser',
      html: PAGE,
      meta: {
        tier: 'browser',
        url: URL,
        finalUrl: URL,
        status: 200,
        redirected: false,
        contentType: 'text/html; charset=utf-8',
        bytes: PAGE.length,
        stealth: false,
      },
    });
  });

  it('tier 2 asks for stealth, sends its headers, and records the echo rather than the wish', async () => {
    const log = seen();
    const provider = fakeProvider({}, log, { stealthEcho: false });

    const attempt = await fetchBrowser(URL, {
      provider,
      tier: 'stealth',
      headers: { 'x-fixture-escalation': 'token' },
    });

    expect(log.requests).toEqual([{ stealth: true }]);
    expect(log.headers).toEqual({ 'x-fixture-escalation': 'token' });
    expect(attempt).toMatchObject({ ok: true, tier: 'stealth', meta: { tier: 'stealth', stealth: false } });
  });

  it('records the echo when the provider did apply stealth', async () => {
    const attempt = await fetchBrowser(URL, { provider: fakeProvider({}, seen(), { stealthEcho: true }), tier: 'stealth' });

    expect(attempt).toMatchObject({ ok: true, meta: { stealth: true } });
  });

  it('reads a redirect off the response chain, and where the page ended up off the page', async () => {
    const provider = fakeProvider({ redirectedFrom: true, landsOn: 'http://shop.test/product/widget-2' }, seen());

    const attempt = await fetchBrowser(URL, { provider, tier: 'browser' });

    expect(attempt).toMatchObject({
      ok: true,
      meta: { url: URL, finalUrl: 'http://shop.test/product/widget-2', redirected: true },
    });
  });

  it('copes with a navigation that produced no response, and with a response with no content type', async () => {
    const silent = await fetchBrowser(URL, { provider: fakeProvider({ noResponse: true }, seen()), tier: 'browser' });
    expect(silent).toMatchObject({ ok: true, meta: { status: 0, contentType: null, redirected: false } });

    const moved = await fetchBrowser(URL, {
      provider: fakeProvider({ noResponse: true, landsOn: 'http://shop.test/elsewhere' }, seen()),
      tier: 'browser',
    });
    expect(moved).toMatchObject({ ok: true, meta: { status: 0, redirected: true } });

    const untyped = await fetchBrowser(URL, { provider: fakeProvider({ contentType: null }, seen()), tier: 'browser' });
    expect(untyped).toMatchObject({ ok: true, meta: { status: 200, contentType: null } });
  });

  it('reports a provider that would not hand over a session as a provider failure', async () => {
    const log = seen();
    const provider = fakeProvider({}, log, {
      acquireFails: new BrowserProviderError('no capacity left', {
        kind: 'capacity',
        provider: 'fake',
        retryable: true,
      }),
    });

    const attempt = await fetchBrowser(URL, { provider, tier: 'browser', timeoutMs: 100 });

    expect(attempt).toMatchObject({
      ok: false,
      tier: 'browser',
      error: { kind: 'provider', message: 'fake (capacity, retryable): no capacity left' },
    });
    expect(log.releases).toBe(0);
  });

  it('reports a navigation timeout as a timeout, naming the budget it had', async () => {
    const slow = new Error('page.goto: Timeout 250ms exceeded.');
    slow.name = 'TimeoutError';
    const log = seen();

    const attempt = await fetchBrowser(URL, { provider: fakeProvider({ failWith: slow }, log), tier: 'browser', timeoutMs: 250 });

    expect(attempt).toMatchObject({ ok: false, error: { kind: 'timeout', message: 'no response within 250ms' } });
    expect(log.releases).toBe(1);
  });

  it('reports any other navigation failure as a network error, first line only', async () => {
    const refused = new Error(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://shop.test/\nCall log:\n  - navigating to "http://shop.test/", waiting until "load"',
    );

    const attempt = await fetchBrowser(URL, { provider: fakeProvider({ failWith: refused }, seen()), tier: 'browser' });

    expect(attempt).toMatchObject({
      ok: false,
      error: { kind: 'network', message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://shop.test/' },
    });
  });

  it('reports a non-Error rejection as a network error rather than crashing the check', async () => {
    const attempt = await fetchBrowser(URL, { provider: fakeProvider({ failWith: 'gone away' }, seen()), tier: 'browser' });

    expect(attempt).toMatchObject({ ok: false, error: { kind: 'network', message: 'gone away' } });
  });

  it('releases the session whether or not the page came back', async () => {
    const served = seen();
    await fetchBrowser(URL, { provider: fakeProvider({}, served), tier: 'browser' });
    expect(served.releases).toBe(1);

    const failed = seen();
    await fetchBrowser(URL, { provider: fakeProvider({ failWith: new Error('boom') }, failed), tier: 'browser' });
    expect(failed.releases).toBe(1);
  });
});

describe('describeBrowserFailure', () => {
  it('names a provider failure by provider and kind, and says whether trying again could help', () => {
    const fatal = new BrowserProviderError('bad key', { kind: 'configuration', provider: 'solari', retryable: false });
    expect(describeBrowserFailure(fatal, DEFAULT_BROWSER_TIMEOUT_MS)).toEqual({
      kind: 'provider',
      message: 'solari (configuration): bad key',
    });
  });
});
