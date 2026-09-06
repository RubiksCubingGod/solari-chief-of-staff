import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ExtractorSpec } from './extractor.js';
import {
  DEFAULT_SNAPSHOT_CHARS,
  REPLAY_FAILURES,
  describeReplayFailure,
  pageSnapshot,
  replayExtractor,
} from './replay.js';

/**
 * The deterministic half of the extractor lifecycle: a stored spec against a
 * page, no model in the room. The pages are the fixture shop's two layouts,
 * recorded rather than served, so this suite runs in milliseconds and what it
 * fixes is the replay engine alone.
 */

/** The fixture shop's product page in its normal layout. */
const NORMAL_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="fixture-state" content="fixture-state:normal" />
    <title>Widget</title>
    <style>.pd-card { padding: 1rem }</style>
    <script>window.__tracking = { loaded: true };</script>
  </head>
  <body>
    <main>
      <article class="pd-card">
        <h1 class="pd-title" data-testid="product-title">Widget</h1>
        <dl class="pd-facts">
          <dt class="pd-term">Price</dt>
          <dd class="pd-value" data-testid="product-price" aria-label="Price">$19.99</dd>
          <dt class="pd-term">Availability</dt>
          <dd class="pd-value" data-testid="product-availability" aria-label="Availability">In stock</dd>
        </dl>
      </article>
    </main>
    <noscript>Enable JavaScript for the full experience.</noscript>
  </body>
</html>
`;

/** The same product after the redesign: every class and id rotated, the hooks kept. */
const REDESIGN_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Widget</title></head>
  <body>
    <main>
      <section class="ProductView" id="pv-root">
        <div class="ProductView__header">
          <h1 class="ProductView__name" data-testid="product-title">Widget</h1>
        </div>
        <div class="ProductView__body" id="pv-body">
          <dl class="ProductView__list">
            <dt class="ProductView__key">Price</dt>
            <dd class="ProductView__val" data-testid="product-price" aria-label="Price">$17.50</dd>
            <dt class="ProductView__key">Availability</dt>
            <dd class="ProductView__val" data-testid="product-availability" aria-label="Availability">In stock</dd>
          </dl>
        </div>
      </section>
    </main>
  </body>
</html>
`;

/** Sold out: the availability row is there, the price row is not. */
const SOLD_OUT_PAGE = `<html><body><main><article class="pd-card">
  <h1 class="pd-title" data-testid="product-title">Widget</h1>
  <dl class="pd-facts"><dt class="pd-term">Availability</dt>
  <dd class="pd-value" data-testid="product-availability">Sold out</dd></dl>
</article></main></body></html>`;

/** A storefront that publishes the price as structured data rather than text. */
const META_PRICE_PAGE = `<html><body><main>
  <meta itemprop="price" content="1299.00" /><meta itemprop="priceCurrency" content="EUR" />
  <span class="price price--discounted">from <b>€1,299</b></span>
</main></body></html>`;

function spec(selector: string, parse: ExtractorSpec['parse'], attribute: string | null = null): ExtractorSpec {
  return { version: 1, strategy: 'css', selector, attribute, parse };
}

const PRICE_BY_HOOK = spec('[data-testid="product-price"]', 'price');
const PRICE_BY_CLASS = spec('dd.pd-value[aria-label="Price"]', 'price');

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('replayExtractor', () => {
  it('names the ways a replay can fail', () => {
    expect(REPLAY_FAILURES).toEqual(['invalid-selector', 'no-match', 'empty', 'unparseable']);
  });

  it('reads a price out of the element the selector names', () => {
    expect(replayExtractor(PRICE_BY_HOOK, NORMAL_PAGE)).toEqual({
      ok: true,
      value: { kind: 'price', amount: 19.99, currency: 'USD', raw: '$19.99' },
      matched: 1,
      text: '$19.99',
    });
  });

  it('is deterministic: the same spec and page give the same value every time', () => {
    const first = replayExtractor(PRICE_BY_HOOK, NORMAL_PAGE);
    const second = replayExtractor(PRICE_BY_HOOK, NORMAL_PAGE);
    expect(second).toEqual(first);
  });

  it('survives the redesign when the spec was written against a stable hook', () => {
    expect(replayExtractor(PRICE_BY_HOOK, REDESIGN_PAGE)).toMatchObject({
      ok: true,
      value: { kind: 'price', amount: 17.5, currency: 'USD' },
    });
  });

  it('breaks on the redesign when the spec leaned on a class name, and says so', () => {
    expect(replayExtractor(PRICE_BY_CLASS, NORMAL_PAGE)).toMatchObject({ ok: true, value: { amount: 19.99 } });
    expect(replayExtractor(PRICE_BY_CLASS, REDESIGN_PAGE)).toEqual({
      ok: false,
      failure: 'no-match',
      reason: 'nothing on the page matches dd.pd-value[aria-label="Price"]',
    });
  });

  it('reads an attribute when the spec names one', () => {
    expect(replayExtractor(spec('meta[itemprop="price"]', 'price', 'content'), META_PRICE_PAGE)).toMatchObject({
      ok: true,
      value: { kind: 'price', amount: 1299, currency: null, raw: '1299.00' },
      text: '1299.00',
    });
  });

  it('reads the first match only for a price, so a list of prices is not a price', () => {
    const page = '<ul><li class="p">$5.00</li><li class="p">$7.00</li></ul>';
    expect(replayExtractor(spec('li.p', 'price'), page)).toMatchObject({
      ok: true,
      value: { amount: 5 },
      matched: 2,
      text: '$5.00',
    });
  });

  it('fails as empty when the match has no text, or no such attribute', () => {
    expect(replayExtractor(spec('meta[itemprop="price"]', 'price'), META_PRICE_PAGE)).toEqual({
      ok: false,
      failure: 'empty',
      reason: 'meta[itemprop="price"] matched, but the match has no text',
    });
    expect(replayExtractor(spec('meta[itemprop="price"]', 'price', 'data-price'), META_PRICE_PAGE)).toEqual({
      ok: false,
      failure: 'empty',
      reason: 'meta[itemprop="price"] matched, but the match has no data-price attribute',
    });
  });

  it('fails as unparseable when the text holds no price, which is what a sold-out row looks like', () => {
    expect(replayExtractor(spec('[data-testid="product-availability"]', 'price'), SOLD_OUT_PAGE)).toEqual({
      ok: false,
      failure: 'unparseable',
      reason: 'no price in "Sold out"',
    });
    expect(replayExtractor(PRICE_BY_HOOK, SOLD_OUT_PAGE)).toMatchObject({ ok: false, failure: 'no-match' });
  });

  it('keeps an unparseable reason short when the match is a wall of text', () => {
    const page = `<p class="blurb">${'lorem '.repeat(40)}</p>`;
    const result = replayExtractor(spec('.blurb', 'price'), page);
    expect(result).toMatchObject({ ok: false, failure: 'unparseable' });
    if (!result.ok) expect(result.reason).toBe(`no price in "${'lorem '.repeat(40).slice(0, 80)}…"`);
  });

  it('refuses a selector the engine cannot parse rather than reporting no match', () => {
    const result = replayExtractor(spec('dd[data-testid=', 'price'), NORMAL_PAGE);
    expect(result).toMatchObject({ ok: false, failure: 'invalid-selector' });
    if (!result.ok) expect(result.reason).toContain('dd[data-testid=');
  });

  it('lists every matched element as a slot, keyed by its attribute when the spec names one', () => {
    const page =
      '<ul><li class="slot" data-id="tue-0900"><span class="when">Tue 8 Sep,\n  09:00</span></li>' +
      '<li class="slot" data-id="thu-1400"><span class="when">Thu 10 Sep, 14:00</span></li></ul>';

    expect(replayExtractor(spec('li.slot .when', 'slots'), page)).toEqual({
      ok: true,
      value: {
        kind: 'slots',
        slots: [
          { id: 'Tue 8 Sep, 09:00', label: 'Tue 8 Sep, 09:00' },
          { id: 'Thu 10 Sep, 14:00', label: 'Thu 10 Sep, 14:00' },
        ],
      },
      matched: 2,
      text: 'Tue 8 Sep, 09:00 Thu 10 Sep, 14:00',
    });
    expect(replayExtractor(spec('li.slot', 'slots', 'data-id'), page)).toMatchObject({
      ok: true,
      value: {
        kind: 'slots',
        slots: [
          { id: 'tue-0900', label: 'Tue 8 Sep, 09:00' },
          { id: 'thu-1400', label: 'Thu 10 Sep, 14:00' },
        ],
      },
    });
  });

  it('reads an empty calendar as an empty listing, not as a broken selector', () => {
    const page = '<ul><li class="empty">No appointments are available.</li></ul>';

    expect(replayExtractor(spec('li.slot .when', 'slots'), page)).toEqual({
      ok: true,
      value: { kind: 'slots', slots: [] },
      matched: 0,
      text: '',
    });
  });

  it('skips a matched slot with no text, and fails as empty when none has any', () => {
    const page = '<ul><li class="slot"><span class="when"></span></li><li class="slot"><span class="when">Tue</span></li></ul>';

    expect(replayExtractor(spec('li.slot .when', 'slots'), page)).toMatchObject({
      ok: true,
      value: { kind: 'slots', slots: [{ id: 'Tue', label: 'Tue' }] },
      matched: 2,
    });
    expect(replayExtractor(spec('li.slot .when', 'slots'), '<ul><li class="slot"><span class="when"> </span></li></ul>')).toEqual({
      ok: false,
      failure: 'empty',
      reason: 'li.slot .when matched, but no match has text',
    });
    // A slot whose id attribute is missing keeps its label as its id rather than dropping out of the listing.
    expect(replayExtractor(spec('li.slot', 'slots', 'data-id'), '<ul><li class="slot">Tue</li></ul>')).toMatchObject({
      ok: true,
      value: { kind: 'slots', slots: [{ id: 'Tue', label: 'Tue' }] },
    });
  });

  it('digests the text of every matched element for a change watch', () => {
    const result = replayExtractor(spec('dl dd', 'digest'), NORMAL_PAGE);
    expect(result).toMatchObject({
      ok: true,
      matched: 2,
      value: { kind: 'digest', digest: sha256('$19.99 In stock'), excerpt: '$19.99 In stock' },
    });

    const whole = replayExtractor(spec('main', 'digest'), NORMAL_PAGE);
    expect(whole).toMatchObject({ ok: true, matched: 1, value: { kind: 'digest' } });
    if (whole.ok && whole.value.kind === 'digest') expect(whole.value.excerpt).toBe('Widget Price $19.99 Availability In stock');
  });

  it('notices a change through the digest and nothing else', () => {
    const before = replayExtractor(spec('main', 'digest'), NORMAL_PAGE);
    const after = replayExtractor(spec('main', 'digest'), REDESIGN_PAGE);
    expect(before.ok && after.ok && before.value.kind === 'digest' && after.value.kind === 'digest').toBe(true);
    if (before.ok && after.ok && before.value.kind === 'digest' && after.value.kind === 'digest') {
      // Same words in a different markup is the same content; a different price is not.
      expect(after.value.digest).not.toBe(before.value.digest);
      const relaid = REDESIGN_PAGE.replace('$17.50', '$19.99');
      const same = replayExtractor(spec('main', 'digest'), relaid);
      if (same.ok && same.value.kind === 'digest') expect(same.value.digest).toBe(before.value.digest);
    }
  });

  it('digests an attribute when asked, and fails as empty when it is missing everywhere', () => {
    expect(replayExtractor(spec('dd', 'digest', 'aria-label'), NORMAL_PAGE)).toMatchObject({
      ok: true,
      value: { kind: 'digest', excerpt: 'Price Availability' },
    });
    expect(replayExtractor(spec('dd', 'digest', 'data-missing'), NORMAL_PAGE)).toEqual({
      ok: false,
      failure: 'empty',
      reason: 'dd matched, but the match has no data-missing attribute',
    });
  });
});

describe('describeReplayFailure', () => {
  it('puts the failure kind in front of the reason', () => {
    expect(describeReplayFailure({ ok: false, failure: 'no-match', reason: 'nothing on the page matches .x' })).toBe(
      'no-match: nothing on the page matches .x',
    );
  });
});

describe('pageSnapshot', () => {
  it('keeps the markup the model needs and drops what it does not', () => {
    const snapshot = pageSnapshot(NORMAL_PAGE);
    expect(snapshot).toContain('data-testid="product-price"');
    expect(snapshot).toContain('<title>Widget</title>');
    expect(snapshot).not.toContain('<script');
    expect(snapshot).not.toContain('__tracking');
    expect(snapshot).not.toContain('<style');
    expect(snapshot).not.toContain('<noscript');
    expect(snapshot).not.toContain('\n');
    expect(snapshot).not.toMatch(/ {2}/u);
  });

  it('strips comments, svg and inline event handlers', () => {
    const page = '<div onclick="track()"><!-- promo --><svg><path d="M0 0"/></svg><b>$5</b></div>';
    expect(pageSnapshot(page)).toBe('<div><b>$5</b></div>');
  });

  it('truncates a long page at the budget and says so', () => {
    const page = `<p>${'x'.repeat(200)}</p>`;
    const snapshot = pageSnapshot(page, 50);
    expect(snapshot.length).toBeLessThanOrEqual(50 + '…[truncated]'.length);
    expect(snapshot.endsWith('…[truncated]')).toBe(true);
    expect(pageSnapshot(page).length).toBeLessThan(DEFAULT_SNAPSHOT_CHARS);
    expect(pageSnapshot(page)).toBe(page);
  });
});
