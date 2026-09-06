import { describe, expect, it } from 'vitest';

import { DEFAULT_HTTP_HEADERS, DEFAULT_HTTP_TIMEOUT_MS, fetchHttp } from './http.js';

/**
 * Tier 0 against an injected `fetch`, so every branch of the seam - what is
 * sent, what comes back, and each way the network can fail to answer - is
 * proved without a socket. The integration test beside this one proves the
 * same seam against real sockets: a fixture page, a server that never
 * answers, and a port nobody listens on.
 */

type FetchLike = typeof globalThis.fetch;

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function respondingWith(response: Response, recorded: Recorded[] = []): FetchLike {
  return (input, init) => {
    recorded.push({ url: urlOf(input), init });
    return Promise.resolve(response);
  };
}

function failingWith(error: unknown): FetchLike {
  // Not always an Error on purpose: one test below is about a runtime that
  // rejects with something else, which the fetcher still has to describe.
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return () => Promise.reject(error);
}

const PAGE = '<html><body><span data-testid="product-price">$19.99</span></body></html>';

describe('fetchHttp', () => {
  it('sends one GET with the browser-like default headers, following redirects, under a timeout', async () => {
    const recorded: Recorded[] = [];
    const send = respondingWith(new Response(PAGE, { status: 200 }), recorded);

    await fetchHttp('https://shop.test/product/1', { fetch: send });

    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call?.url).toBe('https://shop.test/product/1');
    expect(call?.init?.method).toBe('GET');
    expect(call?.init?.redirect).toBe('follow');
    expect(call?.init?.headers).toEqual(DEFAULT_HTTP_HEADERS);
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets a caller add or override headers without losing the defaults', async () => {
    const recorded: Recorded[] = [];
    const send = respondingWith(new Response(PAGE), recorded);

    await fetchHttp('https://shop.test/', { fetch: send, headers: { 'x-fixture-escalation': 't', accept: '*/*' } });

    expect(recorded[0]?.init?.headers).toEqual({
      ...DEFAULT_HTTP_HEADERS,
      'x-fixture-escalation': 't',
      accept: '*/*',
    });
  });

  it('answers with the page and its metadata', async () => {
    const response = new Response(PAGE, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    Object.defineProperty(response, 'url', { value: 'https://shop.test/product/1' });

    const attempt = await fetchHttp('https://shop.test/product/1', { fetch: respondingWith(response) });

    expect(attempt).toMatchObject({
      ok: true,
      tier: 'http',
      html: PAGE,
      meta: {
        tier: 'http',
        url: 'https://shop.test/product/1',
        finalUrl: 'https://shop.test/product/1',
        status: 200,
        redirected: false,
        contentType: 'text/html; charset=utf-8',
        bytes: Buffer.byteLength(PAGE),
        stealth: false,
      },
    });
    expect(attempt.ok && attempt.meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports where a redirect landed', async () => {
    const response = new Response(PAGE, { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://shop.test/product/1-renamed' });
    Object.defineProperty(response, 'redirected', { value: true });

    const attempt = await fetchHttp('https://shop.test/product/1', { fetch: respondingWith(response) });

    expect(attempt.ok && attempt.meta).toMatchObject({
      url: 'https://shop.test/product/1',
      finalUrl: 'https://shop.test/product/1-renamed',
      redirected: true,
    });
  });

  it('falls back to the requested URL when the runtime reports none', async () => {
    const attempt = await fetchHttp('https://shop.test/x', { fetch: respondingWith(new Response(PAGE)) });

    expect(attempt.ok && attempt.meta.finalUrl).toBe('https://shop.test/x');
  });

  it('treats a non-2xx status as content, not as a failure', async () => {
    const response = new Response('<html><body>Checking your browser</body></html>', { status: 403 });

    const attempt = await fetchHttp('https://shop.test/', { fetch: respondingWith(response) });

    expect(attempt.ok).toBe(true);
    expect(attempt.ok && attempt.meta.status).toBe(403);
  });

  it('reports no content type when the response carries none', async () => {
    const response = new Response(null, { status: 204 });

    const attempt = await fetchHttp('https://shop.test/', { fetch: respondingWith(response) });

    expect(attempt.ok && attempt.meta).toMatchObject({ status: 204, contentType: null, bytes: 0 });
  });

  it('reports a timeout as a timeout', async () => {
    const send = failingWith(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const attempt = await fetchHttp('https://shop.test/', { fetch: send, timeoutMs: 250 });

    expect(attempt).toMatchObject({
      ok: false,
      tier: 'http',
      error: { kind: 'timeout', message: 'no response within 250ms' },
    });
    expect(!attempt.ok && attempt.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('reports any other failure to answer as a network error, in its own words', async () => {
    const attempt = await fetchHttp('https://shop.test/', { fetch: failingWith(new TypeError('fetch failed')) });

    expect(attempt).toMatchObject({ ok: false, error: { kind: 'network', message: 'fetch failed' } });
  });

  it('names the cause of a network error when the runtime wraps one', async () => {
    const wrapped = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:1') });

    const attempt = await fetchHttp('https://shop.test/', { fetch: failingWith(wrapped) });

    expect(!attempt.ok && attempt.error.message).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
  });

  it('copes with a rejection that is not an Error', async () => {
    const attempt = await fetchHttp('https://shop.test/', { fetch: failingWith('boom') });

    expect(!attempt.ok && attempt.error).toEqual({ kind: 'network', message: 'boom' });
  });

  it('uses a timeout long enough for a slow shop and short enough for a schedule', () => {
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_HTTP_HEADERS['user-agent']).toMatch(/Mozilla/u);
    expect(DEFAULT_HTTP_HEADERS['accept']).toMatch(/text\/html/u);
  });
});
