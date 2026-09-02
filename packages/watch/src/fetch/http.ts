import type { FetchAttempt, FetchError } from '@chief-of-staff/core';

/**
 * Tier 0 of the fetch ladder: one plain HTTP GET.
 *
 * Most checks should cost exactly this and nothing more. The tier does not
 * judge what it gets back - a 403 challenge page and a 200 product page are
 * both content, and telling them apart is the ladder's block classifier - so
 * the only failures it reports are the ways a site can fail to answer at all.
 * Those matter to the ladder because they are not blocks: a timeout is not a
 * reason to pay for a browser.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

/**
 * What a mainstream browser sends. A bare `node` user agent is a block signal
 * all by itself on most commerce sites, and a missing Accept-Language is the
 * next thing their heuristics look at.
 */
export const DEFAULT_HTTP_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

export interface HttpFetchOptions {
  /** How long the whole request, body included, may take. */
  readonly timeoutMs?: number;
  /** Added to, and overriding, the defaults above. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Injected only so a test can stand in for the network; production omits it. */
  readonly fetch?: typeof globalThis.fetch;
}

export async function fetchHttp(url: string, options: HttpFetchOptions = {}): Promise<FetchAttempt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const send = options.fetch ?? globalThis.fetch;
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - startedAt);

  try {
    const response = await send(url, {
      method: 'GET',
      headers: { ...DEFAULT_HTTP_HEADERS, ...options.headers },
      redirect: 'follow',
      // One signal for the request and the body: a server that answers the
      // headers and then trickles the body is as silent as one that never
      // answers, as far as a schedule is concerned.
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = await response.text();
    return {
      ok: true,
      tier: 'http',
      html,
      meta: {
        tier: 'http',
        url,
        // An injected Response has no URL of its own; the real one always does.
        finalUrl: response.url === '' ? url : response.url,
        status: response.status,
        redirected: response.redirected,
        contentType: response.headers.get('content-type'),
        bytes: Buffer.byteLength(html),
        elapsedMs: elapsedMs(),
        stealth: false,
      },
    };
  } catch (error: unknown) {
    return { ok: false, tier: 'http', error: classify(error, timeoutMs), elapsedMs: elapsedMs() };
  }
}

function classify(error: unknown, timeoutMs: number): FetchError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'timeout', message: `no response within ${String(timeoutMs)}ms` };
  }
  return { kind: 'network', message: describe(error) };
}

/**
 * The runtime's `fetch failed` says nothing on its own; the refused
 * connection underneath it is what a person can act on.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
