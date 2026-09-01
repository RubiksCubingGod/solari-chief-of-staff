import type { BrowserContext, Page } from 'playwright';

/**
 * Egress tiers a consumer can ask a provider for. The names are the vendor's,
 * because a rename here would only obscure which tier was actually served: the
 * echo on {@link SessionMeta} exists to be compared against what was asked for,
 * and a translation layer in between makes that comparison lie.
 */
export type ProxyTier = 'residential' | 'static' | 'mobile';

/**
 * A request for proxied egress. Every field is a wish: a provider may serve a
 * different tier, a different country, or no proxy at all, and says so through
 * {@link SessionMeta.proxy} rather than by failing.
 *
 * A bare country ask is `{country: 'us'}`; `'off'` and `'smart'` are the two
 * modes that take no fields.
 */
export interface ProxyRequest {
  readonly country?: string;
  readonly tier?: ProxyTier;
  /** Sticky-IP label: the same label across sessions asks for the same exit IP. */
  readonly session?: string;
  /** Minutes the sticky label stays pinned. Only meaningful with `session`. */
  readonly sessionDuration?: number;
  readonly asn?: string;
  readonly state?: string;
  readonly city?: string;
}

export type ProxyOption = 'off' | 'smart' | ProxyRequest;

/**
 * What a consumer asks a provider for. Every field is optional and every field
 * is a wish; see {@link SessionMeta} for what was actually applied.
 */
export interface BrowserRequest {
  readonly stealth?: boolean;
  readonly proxy?: ProxyOption;
  readonly captcha?: boolean;
  /** Server-side store of a Playwright `storageState`, addressed by id. */
  readonly profileId?: string;
  readonly recording?: boolean;
}

/** The proxy a session actually got, as reported by the provider. */
export interface AppliedProxy {
  readonly country: string | undefined;
  /**
   * The tier that actually served. A `mobile` ask can be served as
   * `residential`, so this is the field a consumer that requires mobile egress
   * has to assert on.
   */
  readonly tier: ProxyTier | undefined;
}

/**
 * The Playwright storage state a profile seeds a session with. Derived from
 * Playwright's own return type rather than restated, so it cannot drift from
 * what `context.storageState()` produces and what a profile round-trips.
 */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * What was actually applied to a session. **Requests are wishes; echoes are
 * facts.** A consumer that requires a capability asserts on this, never on the
 * fact that acquire returned: a provider that cannot honour an option reports
 * it as not applied instead of failing or pretending.
 *
 * Every field is present and explicitly `undefined` when it does not apply, so
 * "the provider did not say" is never confused with a field the caller forgot
 * to read.
 */
export interface SessionMeta {
  /** The provider's own id for this session. Unique within one provider. */
  readonly sessionId: string;
  readonly stealth: boolean;
  readonly captcha: boolean;
  readonly recording: boolean;
  /** `undefined` means the session is unproxied, whatever was asked for. */
  readonly proxy: AppliedProxy | undefined;
  /**
   * The timezone the browser context reports. Set it on any context built by
   * hand so `Intl` and `Date` agree with the egress country.
   */
  readonly timezoneId: string | undefined;
  /** The profile actually attached, `undefined` when none was. */
  readonly profileId: string | undefined;
  /**
   * Tri-state, and the three states are different facts: `undefined` = no
   * profile attached, `null` = a profile is attached but empty, an object = the
   * profile seeded the session. Test with `=== undefined` / `=== null`, never
   * for truthiness: an empty profile is a successful attach.
   */
  readonly storageState: StorageState | null | undefined;
  /**
   * Hard deadline after which the provider releases the session on its own.
   * `undefined` when the provider imposes none.
   */
  readonly expiresAt: Date | undefined;
}

/**
 * One acquired browser session: a Playwright context, the echo of what was
 * applied to it, and a release that happens exactly once.
 */
export interface BrowserSession {
  readonly meta: SessionMeta;
  readonly context: BrowserContext;
  newPage(): Promise<Page>;
  /** True once release has completed, so a caller can assert on it. */
  readonly released: boolean;
  /**
   * Releases the session and everything the provider holds for it. Idempotent:
   * a second call is a no-op that neither throws nor releases twice.
   */
  release(): Promise<void>;
}

/**
 * The seam every engine drives a browser through. No consumer imports a vendor
 * SDK; they acquire sessions here and read {@link SessionMeta} for the truth
 * about what they got.
 */
export interface BrowserProvider {
  /** Identifies the implementation in errors and logs. */
  readonly name: string;
  acquire(request?: BrowserRequest): Promise<BrowserSession>;
  /**
   * The sessions this provider believes are live. Providers track this
   * themselves, because a vendor with no list endpoint cannot be asked, so
   * tests and smokes can assert that a run leaked nothing.
   */
  liveSessionIds(): readonly string[];
  /**
   * Releases every live session, then tears down whatever the provider itself
   * holds open. Safe to call more than once.
   */
  dispose(): Promise<void>;
}

/**
 * Why an acquire, release, or dispose failed, in the terms a caller has to
 * decide on: retry, fix configuration, or give up.
 *
 * - `configuration` - the request or the deployment is wrong; retrying the same
 *   call cannot help.
 * - `capacity` - no slot is available. Explicitly **not** retryable: a slot only
 *   frees when something else releases, so a retry loop burns quota against a
 *   wall.
 * - `transport` - the call did not land. Retryable.
 * - `unavailable` - a substrate the provider needs is missing where it runs.
 * - `internal` - the provider or its vendor failed in a way none of the above
 *   describes.
 */
export type BrowserErrorKind =
  | 'configuration'
  | 'capacity'
  | 'transport'
  | 'unavailable'
  | 'internal';

export interface BrowserProviderErrorOptions {
  readonly kind: BrowserErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

/**
 * The one error type the seam throws, so a consumer branches on `kind` and
 * `retryable` instead of matching vendor message strings.
 */
export class BrowserProviderError extends Error {
  readonly kind: BrowserErrorKind;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(message: string, options: BrowserProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserProviderError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.retryable = options.retryable;
  }
}

/**
 * Reports a release that failed while the caller's own work had already thrown.
 * The work's error is what the caller is waiting for, so the release failure
 * would otherwise vanish, and a release that did not happen is a held slot,
 * which is exactly the failure this seam exists to make visible.
 */
export type ReleaseFailureSink = (error: unknown, meta: SessionMeta) => void;

export interface WithBrowserOptions {
  readonly onReleaseFailure?: ReleaseFailureSink;
}

/** Writes to stderr, so an unreported release failure is visible by default. */
export const reportReleaseFailureToConsole: ReleaseFailureSink = (error, meta) => {
  console.error(`browser session ${meta.sessionId} failed to release`, error);
};

/**
 * Acquires a session, runs `fn` against it, and releases it in a finally path:
 * on success, on a thrown error, and idempotently if `fn` released it already.
 *
 * When both `fn` and the release fail, `fn`'s error is what propagates. It is
 * the one the caller can act on, and it is the reason the release ran at all.
 * The release failure goes to `onReleaseFailure` rather than being swallowed.
 */
export async function withBrowser<T>(
  provider: BrowserProvider,
  request: BrowserRequest,
  fn: (session: BrowserSession) => Promise<T>,
  options: WithBrowserOptions = {},
): Promise<T> {
  const session = await provider.acquire(request);

  let result: T;
  try {
    result = await fn(session);
  } catch (bodyError) {
    try {
      await session.release();
    } catch (releaseError) {
      const report = options.onReleaseFailure ?? reportReleaseFailureToConsole;
      report(releaseError, session.meta);
    }
    throw bodyError;
  }

  await session.release();
  return result;
}

/**
 * Turns a session's release into a promise that resolves once, however many
 * callers ask for it. Both providers share it, so "idempotent release" is one
 * implementation rather than a rule two of them are trusted to follow.
 *
 * A failed release does **not** mark the session released: the slot is still
 * held, so a retry has to be allowed to reach the vendor again.
 */
export function createReleaseOnce(release: () => Promise<void>): {
  released: () => boolean;
  release: () => Promise<void>;
} {
  let released = false;
  let inFlight: Promise<void> | undefined;

  return {
    released: () => released,
    release: () => {
      if (released) return Promise.resolve();
      inFlight ??= release().then(
        () => {
          released = true;
          inFlight = undefined;
        },
        (error: unknown) => {
          inFlight = undefined;
          throw error;
        },
      );
      return inFlight;
    },
  };
}
