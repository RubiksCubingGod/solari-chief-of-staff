import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BrowserProvider,
  BrowserProviderError,
  type BrowserSession,
  type SessionMeta,
  withBrowser,
} from './provider.js';

/**
 * A provider with no browser behind it. `withBrowser`'s guarantee is about
 * ordering and idempotence, not about Chromium, and proving it against a real
 * browser would make a lifecycle bug look like a flake.
 */
function createFakeProvider(options: { releaseError?: Error; acquireError?: Error } = {}): {
  provider: BrowserProvider;
  releaseCalls: () => number;
} {
  const live = new Set<string>();
  let counter = 0;
  let releaseCalls = 0;

  const provider: BrowserProvider = {
    name: 'fake',
    acquire: () => {
      if (options.acquireError) return Promise.reject(options.acquireError);

      counter += 1;
      const sessionId = `fake-${String(counter)}`;
      live.add(sessionId);

      const meta: SessionMeta = {
        sessionId,
        stealth: false,
        captcha: false,
        recording: false,
        proxy: undefined,
        timezoneId: undefined,
        profileId: undefined,
        storageState: undefined,
        expiresAt: undefined,
      };

      let released = false;
      const session: BrowserSession = {
        meta,
        // The lifecycle tests never touch the context; a stub keeps the fake
        // honest about that instead of half-implementing Playwright.
        context: {} as unknown as BrowserContext,
        newPage: () => Promise.reject(new Error('the fake provider serves no pages')),
        get released() {
          return released;
        },
        release: () => {
          if (released) return Promise.resolve();
          releaseCalls += 1;
          if (options.releaseError) return Promise.reject(options.releaseError);
          released = true;
          live.delete(sessionId);
          return Promise.resolve();
        },
      };

      return Promise.resolve(session);
    },
    liveSessionIds: () => [...live],
    dispose: () => {
      live.clear();
      return Promise.resolve();
    },
  };

  return { provider, releaseCalls: () => releaseCalls };
}

describe('withBrowser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases the session on success and returns the body result', async () => {
    const { provider, releaseCalls } = createFakeProvider();

    const result = await withBrowser(provider, {}, (session) =>
      Promise.resolve(session.meta.sessionId),
    );

    expect(result).toBe('fake-1');
    expect(provider.liveSessionIds()).toEqual([]);
    expect(releaseCalls()).toBe(1);
  });

  it('releases the session when the body throws, and propagates the body error', async () => {
    const { provider, releaseCalls } = createFakeProvider();
    const failure = new Error('engine failed mid-session');

    await expect(withBrowser(provider, {}, () => Promise.reject(failure))).rejects.toBe(failure);

    expect(provider.liveSessionIds()).toEqual([]);
    expect(releaseCalls()).toBe(1);
  });

  it('releases exactly once when the body released the session itself', async () => {
    const { provider, releaseCalls } = createFakeProvider();

    await withBrowser(provider, {}, (session) => session.release());

    expect(provider.liveSessionIds()).toEqual([]);
    expect(releaseCalls()).toBe(1);
  });

  it('surfaces a release failure when the body succeeded', async () => {
    const releaseError = new Error('release did not land');
    const { provider } = createFakeProvider({ releaseError });

    await expect(withBrowser(provider, {}, () => Promise.resolve('done'))).rejects.toBe(
      releaseError,
    );
  });

  it('keeps the body error when both fail, and reports the release failure', async () => {
    const releaseError = new Error('release did not land');
    const bodyError = new Error('engine failed mid-session');
    const { provider } = createFakeProvider({ releaseError });
    const onReleaseFailure = vi.fn();

    await expect(
      withBrowser(provider, {}, () => Promise.reject(bodyError), { onReleaseFailure }),
    ).rejects.toBe(bodyError);

    expect(onReleaseFailure).toHaveBeenCalledTimes(1);
    expect(onReleaseFailure.mock.calls[0]?.[0]).toBe(releaseError);
    expect((onReleaseFailure.mock.calls[0]?.[1] as SessionMeta).sessionId).toBe('fake-1');
  });

  it('reports a swallowed release failure to the console when no sink is supplied', async () => {
    const releaseError = new Error('release did not land');
    const bodyError = new Error('engine failed mid-session');
    const { provider } = createFakeProvider({ releaseError });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(withBrowser(provider, {}, () => Promise.reject(bodyError))).rejects.toBe(bodyError);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain('fake-1');
  });

  it('never runs the body, and tracks nothing, when acquire fails', async () => {
    const acquireError = new BrowserProviderError('no slot', {
      kind: 'capacity',
      provider: 'fake',
      retryable: false,
    });
    const { provider, releaseCalls } = createFakeProvider({ acquireError });
    const body = vi.fn<(session: BrowserSession) => Promise<Page>>();

    await expect(withBrowser(provider, {}, body)).rejects.toBe(acquireError);

    expect(body).not.toHaveBeenCalled();
    expect(provider.liveSessionIds()).toEqual([]);
    expect(releaseCalls()).toBe(0);
  });

  it('passes the request through to the provider', async () => {
    const { provider } = createFakeProvider();
    const acquire = vi.spyOn(provider, 'acquire');

    await withBrowser(provider, { recording: true, stealth: true }, () => Promise.resolve());

    expect(acquire).toHaveBeenCalledWith({ recording: true, stealth: true });
  });
});

describe('BrowserProviderError', () => {
  it('carries the decision a caller has to make, and the vendor error under it', () => {
    const cause = new Error('429 ConcurrencyLimitExceeded');
    const error = new BrowserProviderError('the plan cap is spent', {
      kind: 'capacity',
      provider: 'solari',
      retryable: false,
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('BrowserProviderError');
    expect(error.kind).toBe('capacity');
    expect(error.provider).toBe('solari');
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(cause);
  });

  it('omits the cause rather than recording an undefined one', () => {
    const error = new BrowserProviderError('chromium is not installed', {
      kind: 'unavailable',
      provider: 'local',
      retryable: false,
    });

    expect('cause' in error).toBe(false);
  });
});
