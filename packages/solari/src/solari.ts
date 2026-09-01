import { Solari } from '@solarisdk/browser';
import type { BrowserContext } from 'playwright';

import {
  BrowserProviderError,
  createReleaseOnce,
  reportReleaseFailureToConsole,
  type AppliedProxy,
  type BrowserProvider,
  type BrowserRequest,
  type BrowserSession,
  type ProxyRequest,
  type ReleaseFailureSink,
  type SessionMeta,
  type StorageState,
} from './provider.js';

/**
 * `SolariProvider` — the seam implemented on Solari's cloud browsers.
 *
 * This module is the ONLY place in the workspace that imports
 * `@solarisdk/browser`. That boundary is deliberate: every rule below is a
 * property of the vendor rather than of our design, and a second import site
 * would be a second place to get them wrong.
 */

/** Countries the managed proxy serves. Anything else is a 400 from the gateway. */
export const PROXY_COUNTRIES = [
  'au',
  'br',
  'ca',
  'de',
  'es',
  'fr',
  'gb',
  'in',
  'it',
  'jp',
  'kr',
  'mx',
  'nl',
  'sg',
  'us',
] as const;

/** Sticky-session lifetime bounds. The gateway rejects out-of-range, it does not clamp. */
export const STICKY_DURATION_MINUTES = { min: 1, max: 30 } as const;

export const PROVIDER_NAME = 'solari';

/**
 * The subset of the vendor's `BrowserSession` this provider drives.
 *
 * Declared structurally rather than imported so tests can supply a fake without
 * a live account, and so the one unavoidable cast at the vendor boundary lives
 * in a single documented place: the SDK's Playwright types come from
 * `patchright-core`, a fork, while the seam speaks `playwright`. This package
 * pins `playwright@1.62.1` against the SDK's `patchright-core@1.62.2` so the
 * two stay structurally compatible.
 */
export interface SolariSessionHandle {
  readonly id: string;
  readonly expiresAt: string;
  readonly proxy: { timezoneId: string; country: string; tier?: string } | undefined;
  readonly storageState: StorageState | null | undefined;
  contexts(): BrowserContext[];
  close(): Promise<void>;
}

/** The subset of the vendor client this provider drives. */
export interface SolariClient {
  launch(options: Record<string, unknown>): Promise<SolariSessionHandle>;
  close(): Promise<void>;
}

export interface SolariClientOptions {
  readonly apiKey: string;
  /** Override the region URL. Used by the retry proof to point at a local server. */
  readonly baseUrl?: string;
  /** Per-attempt HTTP timeout. The SDK default is 90s. */
  readonly timeoutMs?: number;
}

export interface SolariProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected client. Absent means build a real one from `apiKey`. */
  readonly client?: SolariClient;
  /** Where a failed release is reported. Defaults to the console reporter. */
  readonly onReleaseFailure?: ReleaseFailureSink;
}

/**
 * Build the vendor client with transport retry switched off.
 *
 * `maxAttempts: 1` is the load-bearing line in this file. The shipped
 * `isRetryableError()` is `return true` unconditionally and the retry loop
 * wraps `POST /sessions`, so a create that succeeds server-side but times out
 * client-side is re-sent — minting a second billable session whose id we never
 * see and whose concurrency slot is held until the orphan reaper runs roughly
 * three and a half minutes later. `solari.retry.test.ts` observes exactly that
 * against a local gateway, and guards this line.
 *
 * Retry is not lost, it moves: callers retry through the seam's typed
 * `retryable` flag, which knows that a 429 must never be retried.
 */
export function createSolariClient(options: SolariClientOptions): Solari {
  return new Solari({
    apiKey: options.apiKey,
    maxAttempts: 1,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function configurationError(message: string): BrowserProviderError {
  return new BrowserProviderError(message, {
    kind: 'configuration',
    provider: PROVIDER_NAME,
    retryable: false,
  });
}

/**
 * Reject locally what the gateway would reject remotely.
 *
 * The cross-field rules are documented and stable, so paying a round trip to be
 * told about them buys nothing — and the gateway's 400 names a status code
 * where this names the rule.
 */
export function preflight(request: BrowserRequest): void {
  const wantsProxy = request.proxy !== undefined && request.proxy !== 'off';
  const stealth = request.stealth ?? false;

  if (wantsProxy && !stealth) {
    throw configurationError('a managed proxy requires stealth: true');
  }
  if ((request.captcha ?? false) && !stealth) {
    throw configurationError('captcha solving requires stealth: true');
  }

  const proxy = request.proxy;
  if (proxy === undefined || proxy === 'off' || proxy === 'smart') return;

  if (proxy.country !== undefined) {
    const served: readonly string[] = PROXY_COUNTRIES;
    if (!served.includes(proxy.country)) {
      throw configurationError(
        `proxy country ${proxy.country} is not served; expected one of ${PROXY_COUNTRIES.join(', ')}`,
      );
    }
  }

  const duration = proxy.sessionDuration;
  if (duration !== undefined) {
    const { min, max } = STICKY_DURATION_MINUTES;
    if (duration < min || duration > max) {
      // The gateway rejects an out-of-range value rather than clamping it, so a
      // caller that guesses loses the whole session, not just the stickiness.
      throw configurationError(
        `proxy sessionDuration must be between ${String(min)} and ${String(max)} minutes`,
      );
    }
  }
}

/** Map the seam's request onto the vendor's create options. */
export function toCreateOptions(request: BrowserRequest): Record<string, unknown> {
  return {
    // Stated rather than defaulted: `retries` re-runs the whole create, so a
    // vendor re-launch would mint a second billable session under one acquire.
    retries: 0,
    stealth: request.stealth ?? false,
    captcha: request.captcha ?? false,
    recording: request.recording ?? false,
    ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
    ...(request.proxy === undefined ? {} : { proxy: request.proxy }),
  };
}

/**
 * Read the proxy the gateway actually attached.
 *
 * Proxy resolution never errors. If the requested tier is unavailable the
 * session is created *unproxied* and the response simply omits `proxy`; a
 * `mobile` ask can also degrade to `residential`. Asserting on the 201 is how a
 * caller ends up running from a datacenter IP it believed was residential.
 */
export function toAppliedProxy(proxy: SolariSessionHandle['proxy']): AppliedProxy | undefined {
  if (proxy === undefined) return undefined;
  return {
    country: proxy.country,
    tier:
      proxy.tier === 'residential' || proxy.tier === 'static' || proxy.tier === 'mobile'
        ? proxy.tier
        : undefined,
  };
}

/**
 * Build the echo.
 *
 * `stealth`, `captcha` and `recording` are reported from the request because
 * the gateway exposes no echo for them — but they are still facts rather than
 * wishes: pool kind is decided solely by `stealth` and is never substituted,
 * and a create that could not honour captcha fails rather than degrading. The
 * one capability that *does* degrade silently is the proxy, and that one is
 * read back off the response.
 */
export function toSessionMeta(handle: SolariSessionHandle, request: BrowserRequest): SessionMeta {
  return {
    sessionId: handle.id,
    stealth: request.stealth ?? false,
    captcha: request.captcha ?? false,
    recording: request.recording ?? false,
    proxy: toAppliedProxy(handle.proxy),
    timezoneId: handle.proxy?.timezoneId,
    profileId: request.profileId,
    storageState: handle.storageState,
    // The gateway stamps an ISO 8601 string; the seam speaks Date so callers
    // do not each re-parse it.
    expiresAt: new Date(handle.expiresAt),
  };
}

interface VendorFailure {
  readonly status?: number;
  readonly code?: string;
}

function readVendorFailure(error: unknown): VendorFailure {
  if (typeof error !== 'object' || error === null) return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/**
 * Classify a vendor failure into the seam's taxonomy.
 *
 * The retryable set is exactly 502/503/504 plus transport errors. 429 is the
 * one that matters most: the vendor's own documentation is explicit that
 * retrying cannot help, because a slot only frees when a session is released —
 * a tight retry loop there burns quota against a wall.
 */
export function describeSolariFailure(error: unknown): never {
  const { status, code } = readVendorFailure(error);
  const message = error instanceof Error ? error.message : String(error);

  const describe = (): { kind: BrowserProviderError['kind']; retryable: boolean } => {
    if (status === 429) return { kind: 'capacity', retryable: false };
    if (status === 402 || status === 428) return { kind: 'configuration', retryable: false };
    if (status === 502 || status === 503 || status === 504) {
      return { kind: 'transport', retryable: true };
    }
    return { kind: 'internal', retryable: false };
  };

  const { kind, retryable } = describe();
  const detail = code === undefined ? message : `${code}: ${message}`;
  throw new BrowserProviderError(`solari acquire failed (${detail})`, {
    kind,
    provider: PROVIDER_NAME,
    retryable,
    cause: error,
  });
}

export function createSolariProvider(options: SolariProviderOptions = {}): BrowserProvider {
  const report = options.onReleaseFailure ?? reportReleaseFailureToConsole;
  const client = options.client ?? buildClient(options);

  /**
   * The session ledger.
   *
   * There is no server-side account to consult: `GET /sessions/:id` is
   * permanently dead and there is no list route, so this map is the only
   * record of what we are holding. An entry is removed on a *confirmed*
   * release and retained on a failed one, because a failed release means the
   * slot is still held — dropping it here is how a provider reports zero live
   * sessions while burning concurrency.
   */
  const live = new Map<string, () => Promise<void>>();
  let disposed = false;

  const acquire = async (request: BrowserRequest = {}): Promise<BrowserSession> => {
    if (disposed) {
      throw configurationError('this provider has been disposed and cannot acquire sessions');
    }
    preflight(request);

    // A failed `launch()` self-releases before throwing, so nothing is
    // registered until we hold a session we are responsible for.
    const handle = await client.launch(toCreateOptions(request)).catch(describeSolariFailure);

    const context = handle.contexts()[0];
    if (context === undefined) {
      await handle.close();
      throw new BrowserProviderError('solari session arrived without its default context', {
        kind: 'internal',
        provider: PROVIDER_NAME,
        retryable: false,
      });
    }

    const meta = toSessionMeta(handle, request);
    const { released, release } = createReleaseOnce(async () => {
      try {
        // Closes the browser AND releases the session. Closing the browser
        // alone would hold the slot until the plan deadline.
        await handle.close();
      } catch (error) {
        report(error, meta);
        throw error;
      }
      live.delete(meta.sessionId);
    });

    live.set(meta.sessionId, release);
    return {
      meta,
      context,
      newPage: () => context.newPage(),
      get released() {
        return released();
      },
      release,
    };
  };

  return {
    name: PROVIDER_NAME,
    acquire,
    liveSessionIds: () => [...live.keys()],
    dispose: async () => {
      disposed = true;
      // Release first, then close. `solari.close()` stops the client's local
      // proxy and releases nothing, so closing first would strand every live
      // session until its plan deadline. Releases are settled rather than
      // awaited in sequence: one stuck session must not become a stuck
      // process, because skipping `solari.close()` keeps Node's event loop
      // alive forever.
      await Promise.allSettled([...live.values()].map((release) => release()));
      await client.close();
    },
  };
}

function buildClient(options: SolariProviderOptions): SolariClient {
  const apiKey = options.apiKey ?? process.env['SOLARI_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw configurationError(
      'SolariProvider needs an API key: pass `apiKey` or set SOLARI_API_KEY',
    );
  }
  const solari = createSolariClient({
    apiKey,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    // The one cast at the vendor boundary. `patchright-core`'s `BrowserContext`
    // and `playwright`'s are the same shape at the pinned versions; see
    // `SolariSessionHandle` above for why the pin exists.
    launch: (launchOptions) =>
      solari.launch(launchOptions) as unknown as Promise<SolariSessionHandle>,
    close: () => solari.close(),
  };
}

export type { ProxyRequest };
