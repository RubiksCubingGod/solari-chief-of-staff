/**
 * The browser substrate: one seam every engine drives a browser through, and
 * the implementations behind it.
 *
 * The invariant the whole package exists to hold: **requests are wishes; echoes
 * are facts.** Consumers ask for stealth, proxied egress, captcha solving, a
 * profile, or a recording, and then read {@link SessionMeta} to learn what they
 * actually got. Nothing outside this package imports a vendor SDK.
 */
export {
  type AppliedProxy,
  type BrowserErrorKind,
  type BrowserProvider,
  BrowserProviderError,
  type BrowserProviderErrorOptions,
  type BrowserRequest,
  type BrowserSession,
  type ProxyOption,
  type ProxyRequest,
  type ProxyTier,
  type ReleaseFailureSink,
  reportReleaseFailureToConsole,
  type SessionMeta,
  type StorageState,
  withBrowser,
  type WithBrowserOptions,
} from './provider.js';

export {
  type ChromiumLauncher,
  createLocalProvider,
  type LocalProviderOptions,
} from './local.js';
