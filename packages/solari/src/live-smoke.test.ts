import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import type { BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type BrowserProvider,
  type BrowserSession,
  type SessionMeta,
} from './provider.js';

import {
  API_KEY_VARIABLE,
  LIVE_SMOKE_FLAG,
  liveSmokeSkipReason,
  liveSuiteName,
  pollReplayUrl,
  probeReplayBody,
  runLiveSmokeWith,
  runTeardowns,
  type LiveSmokeDependencies,
  type ReplayReader,
} from './live-smoke.js';

/**
 * The guard, tested without a network.
 *
 * This is the whole reason `liveSmokeSkipReason` takes an env record instead of
 * reading `process.env`: the decision that governs whether we spend money is a
 * pure function, so it can be pinned down exhaustively here rather than being
 * discovered on a billing statement.
 */

describe('liveSmokeSkipReason', () => {
  it('skips when the opt-in flag is absent, even with a valid key', () => {
    const reason = liveSmokeSkipReason({ [API_KEY_VARIABLE]: 'sk-live-real' });

    // The expensive default. A key on the machine is not consent to spend it.
    expect(reason).toBeDefined();
    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('skips when the flag is set but no key is configured', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1' });

    // Names the missing variable, because this reason is printed by CI and by
    // the runner script and has to tell a human what to fix.
    expect(reason).toBeDefined();
    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats an empty key as absent', () => {
    // An unset Actions secret interpolates to the empty string rather than
    // vanishing, so this is the shape CI actually produces on a fork PR.
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: '' });

    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats a whitespace-only key as absent', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: '   ' });

    expect(reason).toContain(API_KEY_VARIABLE);
  });

  it('treats an empty flag as not opted in', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('does not opt in on a falsey-looking flag value', () => {
    // `SOLARI_LIVE_SMOKE=0` reads as "no" to every human who writes it. Honoring
    // the string's truthiness instead of its meaning would bill them for it.
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '0', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });

  it('returns undefined when the flag is opted in and a key is present', () => {
    const reason = liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: '1', [API_KEY_VARIABLE]: 'sk-live-real' });

    expect(reason).toBeUndefined();
  });

  it('accepts the other conventional opt-in spellings', () => {
    for (const value of ['true', 'TRUE', 'yes', 'on']) {
      expect(liveSmokeSkipReason({ [LIVE_SMOKE_FLAG]: value, [API_KEY_VARIABLE]: 'sk' })).toBeUndefined();
    }
  });

  it('reports the flag first when both are missing', () => {
    // Order matters for the message a human reads: the flag is the thing they
    // are meant to set deliberately, the key is infrastructure.
    const reason = liveSmokeSkipReason({});

    expect(reason).toContain(LIVE_SMOKE_FLAG);
  });
});

/** A 404 from the gateway: the replay is not written yet, not "never will be". */
function notReadyYet(): Error {
  return Object.assign(new Error('replay not found'), { status: 404 });
}

function readerYielding(errors: Error[]): ReplayReader {
  let call = 0;
  return {
    getReplayUrl: (id) => {
      const error = errors[call];
      call += 1;
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve({ url: `https://replays.example/${id}`, contentEncoding: 'gzip' });
    },
  };
}

describe('pollReplayUrl', () => {
  const fast = { timeoutMs: 200, intervalMs: 1 };

  it('returns the location on the first call when the replay is already there', async () => {
    const replay = await pollReplayUrl(readerYielding([]), 'session-a', fast);

    expect(replay.url).toBe('https://replays.example/session-a');
    expect(replay.contentEncoding).toBe('gzip');
    expect(replay.attempts).toBe(1);
  });

  it('polls through the 404 window and reports how many attempts it took', async () => {
    // A live run needed four. The window is measured, not padding.
    const replay = await pollReplayUrl(
      readerYielding([notReadyYet(), notReadyYet(), notReadyYet()]),
      'session-b',
      fast,
    );

    expect(replay.attempts).toBe(4);
  });

  it('rethrows anything that is not a 404 without burning the window', async () => {
    // An expired key or a rejected session id is a standing condition. Spending
    // thirty seconds rediscovering it would bury the real error under a timeout.
    const denied = Object.assign(new Error('forbidden'), { status: 403 });

    await expect(
      pollReplayUrl(readerYielding([denied]), 'session-c', { timeoutMs: 30_000, intervalMs: 1 }),
    ).rejects.toThrow('forbidden');
  });

  it('gives up with the attempt count and the last error when the replay never lands', async () => {
    const always = Array.from({ length: 500 }, notReadyYet);

    await expect(pollReplayUrl(readerYielding(always), 'session-d', fast)).rejects.toThrow(
      /session-d was still absent after \d+ attempts over 200ms: replay not found/u,
    );
  });
});

interface ReplayHost {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function startReplayHost(
  handle: (request: { url: string | undefined }, respond: {
    send: (status: number, headers: Record<string, string>, body: Uint8Array) => void;
  }) => void,
): Promise<ReplayHost> {
  const server: Server = createServer((request, response) => {
    handle(
      { url: request.url },
      {
        send: (status, headers, body) => {
          response.writeHead(status, headers);
          response.end(body);
        },
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}/replay`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let host: ReplayHost | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
});

const NDJSON = '{"type":2}\n{"type":3}\n';

describe('probeReplayBody', () => {
  it('reports ndjson when the response declares gzip and undici inflates it', async () => {
    // The observed live shape. The object really is stored gzipped and the
    // presigned response really does say so - which is exactly why what arrives
    // is already text, and why a parser must not gunzip it.
    host = await startReplayHost((_request, respond) => {
      respond.send(200, { 'content-encoding': 'gzip', 'content-type': 'application/x-ndjson' },
        gzipSync(Buffer.from(NDJSON, 'utf8')));
    });

    const body = await probeReplayBody(host.url);

    expect(body.responseEncoding).toBe('gzip');
    expect(body.shape).toBe('ndjson');
    expect(body.bytes).toBe(Buffer.byteLength(NDJSON, 'utf8'));
  });

  it('reports gzip when the bytes arrive undeclared and nothing inflates them', async () => {
    // The other half of the fork, and the reason the shape is reported rather
    // than assumed: drop the header and the identical bytes reach the caller
    // still compressed.
    host = await startReplayHost((_request, respond) => {
      respond.send(200, { 'content-type': 'application/octet-stream' },
        gzipSync(Buffer.from(NDJSON, 'utf8')));
    });

    const body = await probeReplayBody(host.url);

    expect(body.responseEncoding).toBeUndefined();
    expect(body.shape).toBe('gzip');
  });

  it('refuses a presigned URL that answers with an error', async () => {
    // A presigned URL that has expired answers 403 with a body. Sniffing that
    // body would report `ndjson` for an error document.
    host = await startReplayHost((_request, respond) => {
      respond.send(403, { 'content-type': 'application/xml' },
        Buffer.from('<Error>expired</Error>', 'utf8'));
    });

    await expect(probeReplayBody(host.url)).rejects.toThrow('answered 403');
  });
});

/**
 * The teardown discipline, proven where it is decided.
 *
 * `runLiveSmoke` tears down two independent vendor objects, and the shape of
 * that teardown is the difference between a nightly that fails and a nightly
 * that hangs. The decision lives in `runTeardowns` so it can be driven here
 * rather than only ever by the vendor at 07:17.
 */

function failing(what: string, error: Error): { what: string; run: () => Promise<void> } {
  return { what, run: () => Promise.reject(error) };
}

describe('runTeardowns', () => {
  it('runs every teardown even when an earlier one throws', async () => {
    // The defect this exists to prevent: `await dispose(); await close();` in a
    // finally never reaches `close()` once `dispose()` throws, so the SDK proxy
    // thread outlives the process and CI reports a timeout instead of a failure.
    const ran: string[] = [];

    await runTeardowns([
      { what: 'dispose', run: () => { ran.push('dispose'); return Promise.reject(new Error('boom')); } },
      { what: 'close', run: () => { ran.push('close'); return Promise.resolve(); } },
    ]);

    expect(ran).toEqual(['dispose', 'close']);
  });

  it('reports each failure with the label of what failed', async () => {
    const failures = await runTeardowns([
      failing('dispose', new Error('slot stuck')),
      failing('close', new Error('proxy stuck')),
    ]);

    expect(failures.map((f) => f.what)).toEqual(['dispose', 'close']);
    expect(failures.map((f) => (f.error as Error).message)).toEqual(['slot stuck', 'proxy stuck']);
  });

  it('reports nothing when every teardown succeeds', async () => {
    const failures = await runTeardowns([
      { what: 'dispose', run: () => Promise.resolve() },
      { what: 'close', run: () => Promise.resolve() },
    ]);

    expect(failures).toEqual([]);
  });
});

describe('pollReplayUrl deadline', () => {
  it('gives up near its own deadline when a single attempt never settles', async () => {
    // The budget is 30s in production, and one `getReplayUrl` is allowed 90s by
    // the SDK default. Checking the deadline only *between* attempts lets one
    // hung call overshoot the window it claims to hold by three times.
    const hangs: ReplayReader = { getReplayUrl: () => new Promise(() => undefined) };

    const started = Date.now();
    await expect(pollReplayUrl(hangs, 'session-hang', { timeoutMs: 200, intervalMs: 1 })).rejects.toThrow(
      /session-hang/u,
    );

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('liveSuiteName', () => {
  it('carries the @live tag so the tier can be selected by name', () => {
    // `live-smoke-path.md` asks for an @live-tagged suite and TEST-MATRIX.md
    // declares the tier; `packages/agent` already tags its own live suite.
    expect(liveSuiteName(undefined)).toContain('@live');
  });

  it('keeps the tag when it also has to carry a skip reason', () => {
    const name = liveSuiteName('SOLARI_LIVE_SMOKE is not set');

    expect(name).toContain('@live');
    expect(name).toContain('SOLARI_LIVE_SMOKE is not set');
  });
});

/**
 * The composed live path, driven without a credential.
 *
 * `runLiveSmokeWith` exists so these four outcomes can be pinned here. The
 * teardown they cover was written to close a defect where a failing body
 * skipped the release entirely; proving it only under the nightly would mean
 * the guard against that regression runs solely when someone is being billed.
 */

interface FakeParts {
  readonly dependencies: LiveSmokeDependencies;
  readonly disposed: () => number;
  readonly closed: () => number;
}

function createFakeLivePath(
  options: {
    readonly title?: string;
    readonly sessionId?: string | undefined;
    readonly newPageError?: Error;
    readonly disposeError?: Error;
    readonly closeError?: Error;
  } = {},
): FakeParts {
  let disposed = 0;
  let closed = 0;
  const live = new Set<string>();
  const sessionId = 'sessionId' in options ? options.sessionId : 'fake-session-1';

  const provider: BrowserProvider = {
    name: 'fake',
    acquire: () => {
      if (sessionId !== undefined) live.add(sessionId);

      const meta = {
        sessionId,
        stealth: false,
        captcha: false,
        recording: true,
        proxy: undefined,
        timezoneId: undefined,
        profileId: undefined,
        storageState: undefined,
        expiresAt: undefined,
        // `sessionId` is a string in the contract. The one case that matters
        // here is the vendor failing to honour that, so the fake is allowed to
        // say so rather than the test asserting on a shape it cannot produce.
      } as unknown as SessionMeta;

      let released = false;
      const session: BrowserSession = {
        meta,
        context: {} as unknown as BrowserContext,
        newPage: () => {
          if (options.newPageError) return Promise.reject(options.newPageError);
          const page = {
            goto: () => Promise.resolve(null),
            title: () => Promise.resolve(options.title ?? 'Example Domain'),
          };
          return Promise.resolve(page as unknown as Page);
        },
        get released() {
          return released;
        },
        release: () => {
          released = true;
          if (sessionId !== undefined) live.delete(sessionId);
          return Promise.resolve();
        },
      };

      return Promise.resolve(session);
    },
    liveSessionIds: () => [...live],
    dispose: () => {
      disposed += 1;
      if (options.disposeError) return Promise.reject(options.disposeError);
      live.clear();
      return Promise.resolve();
    },
  };

  const sessions: ReplayReader = {
    getReplayUrl: () =>
      Promise.resolve({ url: 'https://replay.invalid/object', contentEncoding: 'gzip' }),
  };

  return {
    dependencies: {
      provider,
      replayClient: {
        sessions,
        close: () => {
          closed += 1;
          return options.closeError ? Promise.reject(options.closeError) : Promise.resolve();
        },
      },
      probeBody: () =>
        Promise.resolve({ shape: 'ndjson' as const, responseEncoding: 'gzip', bytes: 4_096 }),
    },
    disposed: () => disposed,
    closed: () => closed,
  };
}

describe('runLiveSmokeWith', () => {
  it('reports the composed path and tears both clients down once', async () => {
    const parts = createFakeLivePath();

    const report = await runLiveSmokeWith(parts.dependencies, { apiKey: 'sk-test', flushMs: 0 });

    expect(report.sessionId).toBe('fake-session-1');
    expect(report.title).toBe('Example Domain');
    expect(report.replayUrl).toBe('https://replay.invalid/object');
    expect(report.replayBodyShape).toBe('ndjson');
    expect(report.replayBytes).toBe(4_096);
    // The assert the smoke exists for: the ledger is read after release and
    // before dispose, so an empty list here is a released slot rather than a
    // cleared one.
    expect(report.liveSessionIdsAfterRelease).toEqual([]);
    expect(parts.disposed()).toBe(1);
    expect(parts.closed()).toBe(1);
  });

  it('refuses to report a run whose session never named itself', async () => {
    const parts = createFakeLivePath({ sessionId: undefined });

    await expect(
      runLiveSmokeWith(parts.dependencies, { apiKey: 'sk-test', flushMs: 0 }),
    ).rejects.toThrow('released without ever reporting an id');
    // Still torn down: an unusable report is not a reason to leak a slot.
    expect(parts.disposed()).toBe(1);
    expect(parts.closed()).toBe(1);
  });

  it('propagates the body error and reports teardown failures rather than swallowing either', async () => {
    const newPageError = new Error('the page never opened');
    const parts = createFakeLivePath({ newPageError, disposeError: new Error('dispose failed') });
    const onTeardownFailure = vi.fn();

    await expect(
      runLiveSmokeWith(parts.dependencies, { apiKey: 'sk-test', flushMs: 0, onTeardownFailure }),
    ).rejects.toBe(newPageError);

    // The body's error is the one the caller can act on, so it propagates; the
    // teardown failure is reported instead of replacing it.
    expect(onTeardownFailure).toHaveBeenCalledTimes(1);
    expect(onTeardownFailure.mock.calls[0]?.[0]).toMatchObject({ what: 'provider.dispose()' });
    // The second teardown still ran after the first one threw.
    expect(parts.closed()).toBe(1);
  });

  it('makes a teardown failure the finding when the path itself succeeded', async () => {
    const parts = createFakeLivePath({ closeError: new Error('proxy still up') });

    await expect(
      runLiveSmokeWith(parts.dependencies, { apiKey: 'sk-test', flushMs: 0 }),
    ).rejects.toThrow(/could not tear down: solari\.close\(\): proxy still up/u);
    expect(parts.disposed()).toBe(1);
  });
});
