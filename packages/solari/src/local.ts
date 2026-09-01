import { type Browser, chromium, type LaunchOptions } from 'playwright';

import {
  type BrowserProvider,
  BrowserProviderError,
  type BrowserSession,
  createReleaseOnce,
  type SessionMeta,
} from './provider.js';

/**
 * How the provider gets a Chromium. Injectable so the acquire-failure path -
 * the one that has to leave no tracked session behind - is provable without
 * uninstalling a browser.
 */
export type ChromiumLauncher = (options: LaunchOptions) => Promise<Browser>;

export interface LocalProviderOptions {
  /** Defaults to headless: CI has no display and neither does a worker. */
  readonly headless?: boolean;
  /**
   * Applied to every context this provider creates, and echoed back on
   * `SessionMeta.timezoneId`. Left unset, the context takes the host's
   * timezone, which the provider then reports as unknown rather than guessing.
   */
  readonly timezoneId?: string;
  readonly launch?: ChromiumLauncher;
}

const PROVIDER_NAME = 'local';

/**
 * Playwright's own words when the browser binaries were never downloaded.
 * `pnpm install` does not fetch them, so this is the first failure a stranger
 * to the repository meets, and it is worth answering with the command to run
 * rather than with a path into a cache directory they have never heard of.
 */
const MISSING_BROWSER = "Executable doesn't exist";

function describeLaunchFailure(error: unknown): BrowserProviderError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes(MISSING_BROWSER)) {
    return new BrowserProviderError(
      'Chromium is not installed for this Playwright version. Run `pnpm browsers`.',
      { kind: 'unavailable', provider: PROVIDER_NAME, retryable: false, cause: error },
    );
  }

  return new BrowserProviderError('the local Chromium could not be launched', {
    kind: 'internal',
    provider: PROVIDER_NAME,
    retryable: false,
    cause: error,
  });
}

/**
 * The BrowserProvider every push runs the contract suite against: plain
 * Playwright Chromium on the machine the tests run on.
 *
 * It applies none of the vendor capabilities - no stealth, no proxy, no captcha
 * solving, no recording, no server-side profiles - and echoes each of them as
 * not applied. That honesty is the point: an engine written against this seam
 * behaves the same locally and against Solari, because it reads the echo either
 * way instead of assuming its request was honoured.
 *
 * One Chromium process is shared by every session; a session is one
 * `BrowserContext`, which is what makes releasing one session leave the others
 * running.
 */
export function createLocalProvider(options: LocalProviderOptions = {}): BrowserProvider {
  const launch = options.launch ?? ((launchOptions) => chromium.launch(launchOptions));
  const live = new Map<string, BrowserSession>();

  let browserPromise: Promise<Browser> | undefined;
  let counter = 0;
  let disposed = false;

  function ensureBrowser(): Promise<Browser> {
    // The promise is what is shared, not the resolved browser, so two acquires
    // that race cannot start two Chromium processes and leak one of them. A
    // failed launch is not cached: the usual cause is a browser that was never
    // installed, and the usual fix is to install it, so the next acquire has to
    // be allowed to try again.
    browserPromise ??= launch({ headless: options.headless ?? true }).catch((error: unknown) => {
      browserPromise = undefined;
      throw describeLaunchFailure(error);
    });
    return browserPromise;
  }

  return {
    name: PROVIDER_NAME,

    async acquire() {
      if (disposed) {
        throw new BrowserProviderError('this provider has been disposed', {
          kind: 'configuration',
          provider: PROVIDER_NAME,
          retryable: false,
        });
      }

      const launched = await ensureBrowser();
      const context = await launched.newContext(
        options.timezoneId === undefined ? {} : { timezoneId: options.timezoneId },
      );

      counter += 1;
      const sessionId = `local-${String(counter)}`;

      const meta: SessionMeta = {
        sessionId,
        // Everything Solari sells and plain Playwright does not have. Reported
        // as not applied rather than refused, so the same engine code runs
        // against both providers and asserts on the echo either way.
        stealth: false,
        captcha: false,
        recording: false,
        proxy: undefined,
        timezoneId: options.timezoneId,
        profileId: undefined,
        storageState: undefined,
        // Nothing reclaims a local context on a deadline; it lives until it is
        // released.
        expiresAt: undefined,
      };

      const once = createReleaseOnce(async () => {
        await context.close();
        live.delete(sessionId);
      });

      const session: BrowserSession = {
        meta,
        context,
        newPage: () => context.newPage(),
        get released() {
          return once.released();
        },
        release: once.release,
      };

      live.set(sessionId, session);
      return session;
    },

    liveSessionIds: () => [...live.keys()],

    async dispose() {
      disposed = true;

      // Release first, close second: the sessions are contexts inside this
      // browser, and closing it out from under them would report a clean exit
      // for sessions that were never released.
      for (const session of [...live.values()]) {
        await session.release();
      }

      const pending = browserPromise;
      browserPromise = undefined;
      if (pending === undefined) return;

      // A launch that is still in flight, or that failed, has no browser to
      // close - and dispose is the shutdown path, so it must not turn that into
      // a second failure on top of whatever is already going wrong.
      const launched = await pending.catch(() => undefined);
      await launched?.close();
    },
  };
}
