import type { BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { BrowserProviderError, type BrowserRequest } from './provider.js';
import type { ProviderContractSubject } from './testing/contract.js';
import {
  createSolariProvider,
  preflight,
  type SolariClient,
  type SolariSessionHandle,
} from './solari.js';

/**
 * SolariProvider unit tests. No live calls: the vendor client is injected.
 *
 * Every assertion here encodes a documented Solari behavior rather than a
 * preference of ours, because the whole point of the provider is that these
 * edges are handled once, behind the seam. The governing rule is the sprint's:
 * requests are wishes, echoes are facts.
 */

interface FakeSession {
  readonly id?: string;
  readonly expiresAt?: string;
  readonly proxy?: { timezoneId: string; country: string; tier?: string } | undefined;
  readonly storageState?: SolariSessionHandle['storageState'];
}

interface FakeClientOptions {
  readonly sessions?: FakeSession[];
  readonly launchError?: Error;
  readonly closeError?: Error;
  /**
   * What `contexts()` reports on a fresh session. `'none'` is what a real
   * Solari session does; `'default'` is what the vendor's own type comment
   * claims it does. Both are exercised, because a provider that only works
   * against the documentation is a provider that only works on paper.
   */
  readonly contexts?: 'default' | 'none';
  readonly newContextError?: Error;
}

interface FakeClient extends SolariClient {
  readonly launches: Record<string, unknown>[];
  readonly closedSessionIds: string[];
  /** The contexts sessions shipped with, in launch order. Empty under `'none'`. */
  readonly defaultContexts: BrowserContext[];
  /** How many contexts the provider had to open for itself. */
  readonly contextsOpened: () => number;
  clientClosed: boolean;
  closedAfterReleases: number | undefined;
}

function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const launches: Record<string, unknown>[] = [];
  const closedSessionIds: string[] = [];
  const defaultContexts: BrowserContext[] = [];
  let contextsOpened = 0;
  let minted = 0;

  const client: FakeClient = {
    launches,
    closedSessionIds,
    defaultContexts,
    contextsOpened: () => contextsOpened,
    clientClosed: false,
    closedAfterReleases: undefined,
    launch: (launchOptions) => {
      launches.push(launchOptions);
      if (options.launchError !== undefined) return Promise.reject(options.launchError);
      const seed = options.sessions?.[minted] ?? {};
      const id = seed.id ?? `solari-${String(minted)}`;
      minted += 1;
      const shipped =
        options.contexts === 'none' ? undefined : ({} as unknown as BrowserContext);
      if (shipped !== undefined) defaultContexts.push(shipped);

      const handle: SolariSessionHandle = {
        id,
        expiresAt: seed.expiresAt ?? '2026-09-01T18:00:00.000Z',
        proxy: seed.proxy,
        storageState: seed.storageState,
        contexts: () => (shipped === undefined ? [] : [shipped]),
        newContext: () => {
          if (options.newContextError !== undefined) return Promise.reject(options.newContextError);
          contextsOpened += 1;
          return Promise.resolve({} as unknown as BrowserContext);
        },
        close: () => {
          if (options.closeError !== undefined) return Promise.reject(options.closeError);
          closedSessionIds.push(id);
          return Promise.resolve();
        },
      };
      return Promise.resolve(handle);
    },
    close: () => {
      client.clientClosed = true;
      client.closedAfterReleases = closedSessionIds.length;
      return Promise.resolve();
    },
  };
  return client;
}

/** The vendor's error shape: a message plus an HTTP status and optional code. */
class FakeSolariError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'SolariError';
    this.status = status;
    this.code = code;
  }
}

const STEALTH: BrowserRequest = { stealth: true };

describe('preflight', () => {
  it('rejects a proxy request without stealth before spending a round trip', () => {
    // The gateway answers 400, but a local rejection is free and names the
    // actual rule rather than echoing a status code.
    expect(() => {
      preflight({ proxy: { country: 'us' } });
    }).toThrow(BrowserProviderError);
    expect(() => {
      preflight({ proxy: { country: 'us' } });
    }).toThrow(/stealth/iu);
  });

  it('rejects captcha without stealth', () => {
    expect(() => {
      preflight({ captcha: true });
    }).toThrow(/stealth/iu);
  });

  it('accepts proxy and captcha when stealth is on', () => {
    expect(() => {
      preflight({ stealth: true, captcha: true, proxy: { country: 'gb', tier: 'mobile' } });
    }).not.toThrow();
  });

  it('treats an explicit proxy of off as no proxy at all', () => {
    // "off" is the documented way to say no egress, and it must not drag
    // stealth in with it.
    expect(() => {
      preflight({ proxy: 'off' });
    }).not.toThrow();
  });

  it('rejects a country the gateway does not serve', () => {
    expect(() => {
      preflight({ stealth: true, proxy: { country: 'zz' } });
    }).toThrow(/zz/u);
  });

  it('rejects a sticky duration outside 1-30 minutes, which the gateway rejects rather than clamps', () => {
    expect(() => {
      preflight({ stealth: true, proxy: { country: 'us', session: 'warm-1', sessionDuration: 45 } });
    }).toThrow(/30/u);
  });

  it('reports a preflight failure as a configuration error that retrying cannot fix', () => {
    try {
      preflight({ captcha: true });
      expect.unreachable('preflight should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserProviderError);
      expect((error as BrowserProviderError).kind).toBe('configuration');
      expect((error as BrowserProviderError).retryable).toBe(false);
    }
  });
});

describe('createSolariProvider acquire', () => {
  it('echoes what the gateway applied, not what the caller asked for', async () => {
    // A mobile ask can degrade to residential. The echo is the fact.
    const client = createFakeClient({
      sessions: [{ proxy: { timezoneId: 'Europe/London', country: 'gb', tier: 'residential' } }],
    });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire({
      stealth: true,
      proxy: { country: 'gb', tier: 'mobile' },
    });

    expect(session.meta.proxy).toEqual({ country: 'gb', tier: 'residential' });
    expect(session.meta.timezoneId).toBe('Europe/London');
    expect(session.meta.stealth).toBe(true);
    await provider.dispose();
  });

  it('reports an unproxied session when the response omits proxy, rather than trusting the 201', async () => {
    // Proxy resolution never errors: an unavailable tier yields a session
    // created with no egress at all and a response with no `proxy` field.
    // Asserting on the 201 is how a watch engine silently runs from a
    // datacenter IP it believed was residential.
    const client = createFakeClient({ sessions: [{ proxy: undefined }] });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire({ stealth: true, proxy: { country: 'us' } });

    expect(session.meta.proxy).toBeUndefined();
    expect(session.meta.timezoneId).toBeUndefined();
    await provider.dispose();
  });

  it('preserves the storageState tri-state', async () => {
    const client = createFakeClient({
      sessions: [{ storageState: undefined }, { storageState: null }],
    });
    const provider = createSolariProvider({ client });

    const absent = await provider.acquire();
    const empty = await provider.acquire({ profileId: 'p-1' });

    // undefined = no profile attached; null = a profile that exists and is
    // empty. Collapsing them loses "the profile saved nothing".
    expect(absent.meta.storageState).toBeUndefined();
    expect(empty.meta.storageState).toBeNull();
    await provider.dispose();
  });

  it('maps seam options onto the vendor create options', async () => {
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    await provider.acquire({
      stealth: true,
      captcha: true,
      recording: true,
      profileId: 'p-9',
      proxy: { country: 'us', tier: 'static' },
    });

    expect(client.launches[0]).toMatchObject({
      stealth: true,
      captcha: true,
      recording: true,
      profileId: 'p-9',
      proxy: { country: 'us', tier: 'static' },
    });
    await provider.dispose();
  });

  it('disables the SDK re-launch path so one acquire is one create', async () => {
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    await provider.acquire(STEALTH);

    // `retries` defaults to 0 already, but stating it is the point: this
    // provider owns retry, and a vendor re-launch would mint a second
    // billable session under the same acquire.
    expect(client.launches[0]?.['retries']).toBe(0);
    await provider.dispose();
  });
});

describe('session ledger', () => {
  it('registers every created session and removes it only on a confirmed release', async () => {
    // There is no server-side list: `GET /sessions/:id` is permanently dead,
    // so this ledger is the only account of what we are holding.
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    const first = await provider.acquire(STEALTH);
    const second = await provider.acquire(STEALTH);
    expect([...provider.liveSessionIds()].sort()).toEqual(
      [first.meta.sessionId, second.meta.sessionId].sort(),
    );

    await first.release();
    expect(provider.liveSessionIds()).toEqual([second.meta.sessionId]);

    await provider.dispose();
    expect(provider.liveSessionIds()).toEqual([]);
  });

  it('retains the entry when release fails, because the slot is still held', async () => {
    // A failed release is a leak, not a no-op. Dropping the id here is how a
    // provider reports zero live sessions while burning a third of a Free
    // plan's concurrency for an hour.
    const client = createFakeClient({ closeError: new Error('socket hang up') });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);
    await expect(session.release()).rejects.toThrow(/socket hang up/u);

    expect(provider.liveSessionIds()).toEqual([session.meta.sessionId]);
  });

  it('does not report a session as released when its release threw', async () => {
    const client = createFakeClient({ closeError: new Error('nope') });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);
    await expect(session.release()).rejects.toThrow();

    expect(session.released).toBe(false);
  });

  it('is idempotent on a second release', async () => {
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);
    await session.release();
    await session.release();

    expect(client.closedSessionIds).toEqual([session.meta.sessionId]);
    await provider.dispose();
  });
});

describe('dispose ordering', () => {
  it('releases every live session before closing the client', async () => {
    // `solari.close()` stops the local proxy only; it releases nothing. Closing
    // first would strand every live session until its plan deadline.
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    await provider.acquire(STEALTH);
    await provider.acquire(STEALTH);
    await provider.dispose();

    expect(client.closedSessionIds).toHaveLength(2);
    expect(client.closedAfterReleases).toBe(2);
    expect(client.clientClosed).toBe(true);
  });

  it('closes the client even when a release fails, so the process can exit', async () => {
    // Skipping `solari.close()` hangs Node: the LocalProxy http.Server keeps
    // the event loop alive. A stuck release must not become a stuck process.
    const client = createFakeClient({ closeError: new Error('release failed') });
    const provider = createSolariProvider({ client });

    await provider.acquire(STEALTH);
    await provider.dispose();

    expect(client.clientClosed).toBe(true);
    expect(provider.liveSessionIds()).toHaveLength(1);
  });

  it('is repeatable and refuses further acquires', async () => {
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    await provider.dispose();
    await provider.dispose();

    await expect(provider.acquire(STEALTH)).rejects.toThrow(BrowserProviderError);
  });
});

describe('error taxonomy', () => {
  const cases: readonly {
    label: string;
    error: FakeSolariError;
    kind: string;
    retryable: boolean;
  }[] = [
    {
      label: '429 concurrency is capacity and explicitly not retryable',
      error: new FakeSolariError('too many', 429, 'ConcurrencyLimitExceeded'),
      kind: 'capacity',
      retryable: false,
    },
    {
      label: '402 is a plan problem no retry can fix',
      error: new FakeSolariError('upgrade', 402, 'FeatureRequiresPlan'),
      kind: 'configuration',
      retryable: false,
    },
    {
      label: '428 is a client too old to talk to the gateway',
      error: new FakeSolariError('upgrade client', 428),
      kind: 'configuration',
      retryable: false,
    },
    {
      label: '502 is transport and worth retrying',
      error: new FakeSolariError('bad gateway', 502),
      kind: 'transport',
      retryable: true,
    },
    {
      label: '503 is transport and worth retrying',
      error: new FakeSolariError('unavailable', 503),
      kind: 'transport',
      retryable: true,
    },
    {
      label: '504 is transport and worth retrying',
      error: new FakeSolariError('timeout', 504),
      kind: 'transport',
      retryable: true,
    },
    {
      label: '500 surfaces immediately rather than retrying',
      error: new FakeSolariError('boom', 500),
      kind: 'internal',
      retryable: false,
    },
  ];

  for (const { label, error, kind, retryable } of cases) {
    it(label, async () => {
      const provider = createSolariProvider({ client: createFakeClient({ launchError: error }) });

      const thrown = (await provider
        .acquire(STEALTH)
        .catch((caught: unknown) => caught)) as BrowserProviderError;

      expect(thrown).toBeInstanceOf(BrowserProviderError);
      expect(thrown.kind).toBe(kind);
      expect(thrown.retryable).toBe(retryable);
      expect(thrown.provider).toBe('solari');
      expect(thrown.cause).toBe(error);
      await provider.dispose();
    });
  }

  it('leaves the ledger empty when acquire fails, since launch self-releases', async () => {
    const client = createFakeClient({ launchError: new FakeSolariError('boom', 503) });
    const provider = createSolariProvider({ client });

    await expect(provider.acquire(STEALTH)).rejects.toThrow(BrowserProviderError);

    expect(provider.liveSessionIds()).toEqual([]);
    await provider.dispose();
  });

  it('classifies an unrecognised failure as internal rather than guessing it is retryable', async () => {
    const client = createFakeClient({ launchError: new TypeError('undefined is not a function') });
    const provider = createSolariProvider({ client });

    const thrown = (await provider
      .acquire(STEALTH)
      .catch((caught: unknown) => caught)) as BrowserProviderError;

    expect(thrown.kind).toBe('internal');
    expect(thrown.retryable).toBe(false);
    await provider.dispose();
  });
});

describe('provider identity', () => {
  it('requires an api key when no client is injected', () => {
    expect(() => createSolariProvider({})).toThrow(BrowserProviderError);
  });

  it('names itself so a mixed deployment can tell its sessions apart', () => {
    const provider = createSolariProvider({ client: createFakeClient() });
    expect(provider.name).toBe('solari');
  });

  it('surfaces the session deadline the plan stamped', async () => {
    const client = createFakeClient({ sessions: [{ expiresAt: '2026-09-01T19:30:00.000Z' }] });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);

    // There is no idle timeout and no way to extend: a caller that needs to
    // know how long it has can only read this.
    expect(session.meta.expiresAt).toEqual(new Date('2026-09-01T19:30:00.000Z'));
    await provider.dispose();
  });

  it('opens the context itself when the session ships without one', async () => {
    // The vendor's type comment says "Sessions ship with a default context at
    // contexts()[0]". They do not. A real session reports zero contexts until
    // something opens one, and the first live run aborted on every single
    // acquire because this provider believed the comment. Observed against the
    // real gateway: Chromium 151.0.7922.34, launch ~750ms, contexts().length 0,
    // rising to 1 only after a page was opened.
    const client = createFakeClient({ contexts: 'none' });
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);

    expect(session.context).toBeDefined();
    expect(client.contextsOpened()).toBe(1);
    await provider.dispose();
  });

  it('reuses the shipped context when a session does come with one', async () => {
    // The documented shape, kept covered: if the vendor starts honouring its
    // own comment, opening a second context would be a silent waste rather
    // than a failure, and nothing else would notice.
    const client = createFakeClient();
    const provider = createSolariProvider({ client });

    const session = await provider.acquire(STEALTH);

    expect(session.context).toBe(client.defaultContexts[0]);
    expect(client.contextsOpened()).toBe(0);
    await provider.dispose();
  });

  it('fails loudly, and releases the slot, when no context can be had at all', async () => {
    const client = createFakeClient({
      contexts: 'none',
      newContextError: new Error('no context for you'),
    });
    const provider = createSolariProvider({ client });

    await expect(provider.acquire(STEALTH)).rejects.toThrow(BrowserProviderError);
    // The session was created and is billable; failing without closing it would
    // hold the slot until the plan deadline.
    expect(client.closedSessionIds).toEqual(['solari-0']);
    expect(provider.liveSessionIds()).toEqual([]);
  });
});

describe('release failure reporting', () => {
  it('reports a failed release through the injected sink rather than swallowing it', async () => {
    const onReleaseFailure = vi.fn();
    const client = createFakeClient({ closeError: new Error('gone') });
    const provider = createSolariProvider({ client, onReleaseFailure });

    const session = await provider.acquire(STEALTH);
    await expect(session.release()).rejects.toThrow();

    expect(onReleaseFailure).toHaveBeenCalledOnce();
    expect(onReleaseFailure.mock.calls[0]?.[1]).toMatchObject({ sessionId: session.meta.sessionId });
  });
});

describe('provider contract compatibility', () => {
  it('satisfies the shared contract subject, so the suite can drive it as-is', async () => {
    // Compile-time teeth: this only typechecks if SolariProvider implements the
    // same seam LocalProvider does. Running the suite against Solari needs a
    // live credential and belongs to the smoke task, but the shape claim is
    // free and would otherwise only break there.
    const subject: ProviderContractSubject = {
      name: 'SolariProvider',
      create: () => createSolariProvider({ client: createFakeClient() }),
      applies: { stealth: true, proxy: true, captcha: true, recording: true },
    };

    expect(subject.name).toBe('SolariProvider');
    expect((await subject.create()).name).toBe('solari');
  });
});
