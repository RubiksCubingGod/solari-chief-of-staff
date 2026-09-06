import type { FetchAttempt, FetchError } from '@chief-of-staff/core';
import { BrowserProviderError, withBrowser, type BrowserProvider } from '@chief-of-staff/solari';

/**
 * Tiers 1 and 2 of the ladder: the page as a browser sees it.
 *
 * The same code serves both tiers. What differs is the request made of the
 * provider - tier 2 asks for stealth - and the headers sent, which is how the
 * escalation-marked tier identifies itself where the site looks for that.
 * The provider answers with what it actually applied, and that echo is what
 * goes into the fetch record. The local Chromium answers "no stealth" to every
 * request, and a fetch made through it says so.
 */

/** Longer than plain HTTP: a browser has scripts to run before the page is the page. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

export type BrowserTier = 'browser' | 'stealth';

export interface BrowserFetchOptions {
  readonly provider: BrowserProvider;
  readonly tier: BrowserTier;
  /** Sent with every request the page makes. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export async function fetchBrowser(url: string, options: BrowserFetchOptions): Promise<FetchAttempt> {
  const { provider, tier } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);

  try {
    return await withBrowser(provider, tier === 'stealth' ? { stealth: true } : {}, async (session) => {
      const page = await session.newPage();
      if (options.headers !== undefined) await page.setExtraHTTPHeaders({ ...options.headers });
      // `load` rather than `domcontentloaded`: a shell that materialises its
      // content from a DOMContentLoaded handler has done so by the time the
      // load event fires, and it is the materialised page we are here for.
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'load' });
      const html = await page.content();
      const finalUrl = page.url();
      return {
        ok: true,
        tier,
        html,
        meta: {
          tier,
          url,
          finalUrl,
          // No response is a navigation that never touched the network; the
          // page is whatever the browser has, and there is no status to report.
          status: response?.status() ?? 0,
          redirected: response === null ? finalUrl !== url : response.request().redirectedFrom() !== null,
          contentType: response?.headers()['content-type'] ?? null,
          bytes: new TextEncoder().encode(html).byteLength,
          elapsedMs: elapsedMs(),
          stealth: session.meta.stealth,
        },
      };
    });
  } catch (error: unknown) {
    return { ok: false, tier, error: describeBrowserFailure(error, timeoutMs), elapsedMs: elapsedMs() };
  }
}

/**
 * A provider that could not hand over a session is a different failure from a
 * site that did not answer, and the ladder treats them differently: neither
 * escalates, but only one of them is about the site.
 */
export function describeBrowserFailure(error: unknown, timeoutMs: number): FetchError {
  if (error instanceof BrowserProviderError) {
    const retry = error.retryable ? ', retryable' : '';
    return { kind: 'provider', message: `${error.provider} (${error.kind}${retry}): ${error.message}` };
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'timeout', message: `no response within ${String(timeoutMs)}ms` };
  }
  return { kind: 'network', message: firstLine(error instanceof Error ? error.message : String(error)) };
}

/** Playwright appends a call log to its messages; the first line is the error. */
function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? message;
}
