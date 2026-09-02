import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type BrowserProvider,
  BrowserProviderError,
  type BrowserRequest,
  withBrowser,
} from '../provider.js';

/**
 * The capabilities an implementation is expected to actually apply. The suite
 * asserts the echo against this rather than against the request, so a provider
 * that applies nothing and one that applies everything are held to the same
 * rule: say what you did.
 */
export interface AppliedCapabilities {
  readonly stealth: boolean;
  readonly proxy: boolean;
  readonly captcha: boolean;
  readonly recording: boolean;
}

export interface ProviderContractSubject {
  /** Names the describe block, so a failure says which implementation broke. */
  readonly name: string;
  /** A fresh provider per test file. */
  create(): BrowserProvider | Promise<BrowserProvider>;
  readonly applies: AppliedCapabilities;
}

const PAGE_TITLE = 'browser provider contract';
const PAGE_MARKER = 'contract-suite-marker';

interface StaticSite {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Local static content the contract suite drives. Deliberately not a fixture
 * site: the seam has to be provable without the fixture harness, or the two
 * sprints could not be built in parallel and a fixture change could redden a
 * provider proof.
 */
function startStaticSite(): Promise<StaticSite> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html><head><title>${PAGE_TITLE}</title></head>` +
        `<body><p data-testid="marker">${PAGE_MARKER}</p></body></html>`,
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(port)}/`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}

/**
 * The one contract every BrowserProvider is held to. It runs against any
 * implementation, so each is proven by the same assertions rather than by two
 * suites that happen to agree today.
 */
export function describeBrowserProviderContract(subject: ProviderContractSubject): void {
  describe(`BrowserProvider contract: ${subject.name}`, () => {
    let provider: BrowserProvider;
    let site: StaticSite;

    beforeAll(async () => {
      provider = await subject.create();
      site = await startStaticSite();
    });

    afterAll(async () => {
      await provider.dispose();
      await site.close();
    });

    it('acquires a session, drives a page, and releases it', async () => {
      const session = await provider.acquire();

      expect(provider.liveSessionIds()).toContain(session.meta.sessionId);

      const page = await session.newPage();
      await page.goto(site.url);

      expect(await page.title()).toBe(PAGE_TITLE);
      expect(await page.getByTestId('marker').textContent()).toBe(PAGE_MARKER);

      await session.release();

      expect(session.released).toBe(true);
      expect(provider.liveSessionIds()).not.toContain(session.meta.sessionId);
    });

    it('echoes what was applied, not what was asked for', async () => {
      const request: BrowserRequest = {
        stealth: true,
        captcha: true,
        recording: true,
        proxy: { country: 'us', tier: 'mobile' },
      };

      await withBrowser(provider, request, async (session) => {
        const { meta } = session;

        expect(meta.stealth).toBe(subject.applies.stealth);
        expect(meta.captcha).toBe(subject.applies.captcha);
        expect(meta.recording).toBe(subject.applies.recording);

        if (subject.applies.proxy) {
          expect(meta.proxy).toBeDefined();
        } else {
          // Not "an empty proxy object": an unproxied session says so by having
          // no proxy at all, which is the check a consumer that requires egress
          // makes before it trusts what it is about to do with the page.
          expect(meta.proxy).toBeUndefined();
        }

        expect(meta.sessionId).not.toBe('');
        await Promise.resolve();
      });
    });

    it('reports no attached profile as an absent storage state, not an empty one', async () => {
      await withBrowser(provider, {}, async (session) => {
        expect(session.meta.profileId).toBeUndefined();
        expect(session.meta.storageState).toBeUndefined();
        await Promise.resolve();
      });
    });

    it('releases the session when the body succeeds', async () => {
      let acquired = '';

      await withBrowser(provider, {}, async (session) => {
        acquired = session.meta.sessionId;
        expect(provider.liveSessionIds()).toContain(acquired);
        await Promise.resolve();
      });

      expect(acquired).not.toBe('');
      expect(provider.liveSessionIds()).not.toContain(acquired);
    });

    it('releases the session when the body throws, and propagates that error', async () => {
      let acquired = '';
      const failure = new Error('engine failed mid-session');

      await expect(
        withBrowser(provider, {}, async (session) => {
          acquired = session.meta.sessionId;
          await Promise.resolve();
          throw failure;
        }),
      ).rejects.toBe(failure);

      expect(acquired).not.toBe('');
      expect(provider.liveSessionIds()).not.toContain(acquired);
    });

    it('treats a second release as a no-op rather than a second release', async () => {
      const session = await provider.acquire();

      await session.release();
      await session.release();
      await expect(session.release()).resolves.toBeUndefined();

      expect(session.released).toBe(true);
      expect(provider.liveSessionIds()).not.toContain(session.meta.sessionId);
    });

    it('does not double-release a session the body released itself', async () => {
      let acquired = '';

      await withBrowser(provider, {}, async (session) => {
        acquired = session.meta.sessionId;
        await session.release();
      });

      expect(provider.liveSessionIds()).not.toContain(acquired);
    });

    it('disposes to an empty ledger, repeatably, and refuses to acquire afterwards', async () => {
      const session = await provider.acquire();
      await session.release();

      await provider.dispose();

      expect(provider.liveSessionIds()).toEqual([]);
      // A worker that shuts down twice must not turn a clean exit into an
      // unhandled rejection.
      await expect(provider.dispose()).resolves.toBeUndefined();

      await expect(provider.acquire()).rejects.toBeInstanceOf(BrowserProviderError);

      expect(provider.liveSessionIds()).toEqual([]);
    });
  });
}
