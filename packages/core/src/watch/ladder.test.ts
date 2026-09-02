import { describe, expect, it } from 'vitest';

import type { FetchAttempt, FetchMeta } from './fetch.js';
import {
  BLOCK_SIGNALS,
  classifyPage,
  describeOutcome,
  runLadder,
  tierFloorAfter,
  tiersToTry,
  type LadderOutcome,
  type TierFetcher,
} from './ladder.js';

/**
 * The ladder's judgment, with the tiers themselves replaced by scripted
 * fetchers. What is fixed here is the tiered-fetching spec's invariant:
 * escalation is monotonic within a check, a block is the only thing that
 * escalates, and cost order is respected - no browser is paid for until
 * plain HTTP has been refused.
 */

const PRODUCT_PAGE = `<!doctype html><html><head><title>Widget</title></head><body>
  <main><h1 data-testid="product-title">Widget</h1>
  <dl><dt>Price</dt><dd data-testid="product-price">$19.99</dd><dt>Stock</dt><dd>In stock</dd></dl>
  <p>A very fine widget, suitable for most purposes and available now.</p></main></body></html>`;

const CHALLENGE_PAGE = `<!doctype html><html><head><title>Checking your browser</title></head><body>
  <div class="ch-challenge" data-testid="captcha-challenge"><h1>Checking your browser</h1>
  <p>Enable JavaScript and cookies to continue.</p></div></body></html>`;

/** What a script-executing client sees of the fixture's blocked shell: the body replaced, the title not. */
const MATERIALIZED_PAGE = `<!doctype html><html><head><title>Checking your browser</title></head><body>
  <main><h1 data-testid="product-title">Widget</h1><dd data-testid="product-price">$19.99</dd>
  <p>A very fine widget, suitable for most purposes and available now.</p></main></body></html>`;

const CLOUDFLARE_PAGE = `<html><head><title>Just a moment...</title></head><body>
  <div id="challenge-platform"><p>Verifying you are human. This may take a few seconds.</p></div>
  <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;

const RECAPTCHA_PAGE = `<html><body><form><div class="g-recaptcha" data-sitekey="abc"></div>
  <p>Solve the puzzle below to continue to the site.</p></form></body></html>`;

const EMPTY_SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <script src="/static/js/main.js"></script></body></html>`;

const NOSCRIPT_ONLY_WARNING = `<html><body><noscript>Enable JavaScript and cookies to continue.</noscript>
  <main><h1>Widget</h1><p>A very fine widget, suitable for most purposes and available now.</p></main></body></html>`;

describe('classifyPage', () => {
  it('names the three block signals', () => {
    expect(BLOCK_SIGNALS).toEqual(['challenge-markers', 'block-status', 'empty-shell']);
  });

  it('passes an ordinary page', () => {
    expect(classifyPage(PRODUCT_PAGE, 200)).toEqual({ kind: 'ok' });
  });

  it('reads 404 and 410 as the page being gone, whatever the body says', () => {
    expect(classifyPage(CHALLENGE_PAGE, 404)).toEqual({ kind: 'gone' });
    expect(classifyPage(PRODUCT_PAGE, 410)).toEqual({ kind: 'gone' });
  });

  it.each([401, 403, 429, 503])('reads a %d as a block by status', (status) => {
    expect(classifyPage(PRODUCT_PAGE, status)).toEqual({ kind: 'blocked', signal: 'block-status' });
  });

  it('does not read other server errors as blocks', () => {
    expect(classifyPage('<html><body>Internal error: the upstream did not answer in time.</body></html>', 500)).toEqual({
      kind: 'ok',
    });
  });

  it.each([
    ['a browser-check shell', CHALLENGE_PAGE],
    ['a Cloudflare interstitial', CLOUDFLARE_PAGE],
    ['a captcha form', RECAPTCHA_PAGE],
  ])('recognises %s as a challenge', (_label, html) => {
    expect(classifyPage(html, 200)).toEqual({ kind: 'blocked', signal: 'challenge-markers' });
  });

  it('judges the body, not the title, so a materialised shell passes', () => {
    expect(classifyPage(MATERIALIZED_PAGE, 200)).toEqual({ kind: 'ok' });
  });

  it('ignores what a noscript block says to clients that cannot run scripts', () => {
    expect(classifyPage(NOSCRIPT_ONLY_WARNING, 200)).toEqual({ kind: 'ok' });
  });

  it('reads a page with no visible text as an empty shell', () => {
    expect(classifyPage(EMPTY_SHELL, 200)).toEqual({ kind: 'blocked', signal: 'empty-shell' });
    expect(classifyPage('', 200)).toEqual({ kind: 'blocked', signal: 'empty-shell' });
  });
});

describe('tiersToTry', () => {
  it('climbs from the floor under the auto policy', () => {
    expect(tiersToTry('auto', 'http')).toEqual(['http', 'browser', 'stealth']);
    expect(tiersToTry('auto', 'browser')).toEqual(['browser', 'stealth']);
    expect(tiersToTry('auto', 'stealth')).toEqual(['stealth']);
  });

  it('tries exactly the pinned tier, whatever the floor learned', () => {
    expect(tiersToTry('http', 'browser')).toEqual(['http']);
    expect(tiersToTry('browser', 'http')).toEqual(['browser']);
    expect(tiersToTry('stealth', 'http')).toEqual(['stealth']);
  });
});

function meta(tier: FetchMeta['tier'], status = 200): FetchMeta {
  return {
    tier,
    url: 'https://shop.test/',
    finalUrl: 'https://shop.test/',
    status,
    redirected: false,
    contentType: 'text/html',
    bytes: 100,
    elapsedMs: 5,
    stealth: tier === 'stealth',
  };
}

function serving(tier: FetchMeta['tier'], html: string, status = 200): FetchAttempt {
  return { ok: true, tier, html, meta: meta(tier, status) };
}

function failing(tier: FetchMeta['tier'], kind: 'timeout' | 'network' | 'provider'): FetchAttempt {
  return { ok: false, tier, error: { kind, message: `${kind} at ${tier}` }, elapsedMs: 5 };
}

interface Scripted {
  readonly fetchers: Readonly<Record<FetchMeta['tier'], TierFetcher>>;
  readonly calls: FetchMeta['tier'][];
}

function scripted(attempts: Partial<Record<FetchMeta['tier'], FetchAttempt>>): Scripted {
  const calls: FetchMeta['tier'][] = [];
  const fetcher =
    (tier: FetchMeta['tier']): TierFetcher =>
    () => {
      calls.push(tier);
      const attempt = attempts[tier];
      if (attempt === undefined) throw new Error(`the ${tier} tier was not expected to be called`);
      return Promise.resolve(attempt);
    };
  return { fetchers: { http: fetcher('http'), browser: fetcher('browser'), stealth: fetcher('stealth') }, calls };
}

const ALL_TIERS = ['http', 'browser', 'stealth'] as const;

describe('runLadder', () => {
  it('stops at the first tier that serves the page', async () => {
    const script = scripted({ http: serving('http', PRODUCT_PAGE) });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({ kind: 'fetched', tier: 'http', html: PRODUCT_PAGE });
    expect(script.calls).toEqual(['http']);
    expect(outcome.attempts).toHaveLength(1);
  });

  it('escalates past a block, one tier at a time, and never back down', async () => {
    const script = scripted({
      http: serving('http', CHALLENGE_PAGE),
      browser: serving('browser', CHALLENGE_PAGE, 403),
      stealth: serving('stealth', PRODUCT_PAGE),
    });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({ kind: 'fetched', tier: 'stealth', html: PRODUCT_PAGE });
    expect(script.calls).toEqual(['http', 'browser', 'stealth']);
    expect(outcome.attempts.map((attempt) => attempt.tier)).toEqual(['http', 'browser', 'stealth']);
  });

  it('ends blocked, with the last signal, when every tier is refused', async () => {
    const script = scripted({
      http: serving('http', CHALLENGE_PAGE),
      browser: serving('browser', EMPTY_SHELL),
      stealth: serving('stealth', PRODUCT_PAGE, 403),
    });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({
      kind: 'blocked',
      tiersTried: ['http', 'browser', 'stealth'],
      signal: 'block-status',
    });
  });

  it('respects a pinned tier: one refusal is the whole ladder', async () => {
    const script = scripted({ browser: serving('browser', CHALLENGE_PAGE) });

    const outcome = await runLadder('https://shop.test/', ['browser'], script.fetchers);

    expect(outcome).toMatchObject({ kind: 'blocked', tiersTried: ['browser'], signal: 'challenge-markers' });
    expect(script.calls).toEqual(['browser']);
  });

  it('does not pay for a browser over a timeout: a fetch error ends the check at its tier', async () => {
    const script = scripted({ http: failing('http', 'timeout') });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({ kind: 'error', tier: 'http', error: { kind: 'timeout' } });
    expect(script.calls).toEqual(['http']);
  });

  it('reports a provider failure at the tier that needed the provider', async () => {
    const script = scripted({ http: serving('http', CHALLENGE_PAGE), browser: failing('browser', 'provider') });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({ kind: 'error', tier: 'browser', error: { kind: 'provider' } });
    expect(outcome.attempts).toHaveLength(2);
  });

  it('refuses an empty ladder rather than reporting a block nobody saw', async () => {
    await expect(runLadder('https://shop.test/', [], scripted({}).fetchers)).rejects.toThrow(
      'the ladder needs at least one tier',
    );
  });

  it('reports a vanished page without escalating: a 404 is not a block', async () => {
    const script = scripted({ http: serving('http', '<html><body>Not found</body></html>', 404) });

    const outcome = await runLadder('https://shop.test/', ALL_TIERS, script.fetchers);

    expect(outcome).toMatchObject({ kind: 'gone', tier: 'http' });
    expect(script.calls).toEqual(['http']);
  });
});

describe('tierFloorAfter', () => {
  const fetchedAt = (tier: FetchMeta['tier']): LadderOutcome => ({
    kind: 'fetched',
    tier,
    html: PRODUCT_PAGE,
    meta: meta(tier),
    attempts: [],
  });

  it('rises to the tier that served the page and stays there', () => {
    expect(tierFloorAfter('http', fetchedAt('browser'))).toBe('browser');
    expect(tierFloorAfter('browser', fetchedAt('browser'))).toBe('browser');
    expect(tierFloorAfter('http', fetchedAt('http'))).toBe('http');
  });

  it('never lowers the floor: a pinned cheaper tier that served does not un-learn a block', () => {
    expect(tierFloorAfter('stealth', fetchedAt('http'))).toBe('stealth');
  });

  it('leaves the floor alone when nothing was served', () => {
    const blocked: LadderOutcome = { kind: 'blocked', tiersTried: ['http'], signal: 'empty-shell', attempts: [] };
    const gone: LadderOutcome = { kind: 'gone', tier: 'http', attempts: [] };
    expect(tierFloorAfter('http', blocked)).toBe('http');
    expect(tierFloorAfter('browser', gone)).toBe('browser');
  });
});

describe('describeOutcome', () => {
  it('says what happened in words a person can act on', () => {
    expect(describeOutcome({ kind: 'fetched', tier: 'browser', html: '', meta: meta('browser'), attempts: [] })).toBe(
      'fetched at the browser tier',
    );
    expect(
      describeOutcome({ kind: 'blocked', tiersTried: ['http', 'browser'], signal: 'challenge-markers', attempts: [] }),
    ).toBe('blocked at every tier tried (http, browser): challenge-markers');
    expect(describeOutcome({ kind: 'gone', tier: 'http', attempts: [] })).toBe('the page is gone (404 or 410)');
    expect(
      describeOutcome({
        kind: 'error',
        tier: 'http',
        error: { kind: 'timeout', message: 'no response within 15000ms' },
        attempts: [],
      }),
    ).toBe('fetch failed at the http tier: timeout: no response within 15000ms');
  });
});
