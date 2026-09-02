import { describe, expect, it } from 'vitest';

import { compare, priceSatisfies, triggerDedupKey } from './comparator.js';
import type { WatchCondition } from './condition.js';
import type { DigestValue, PriceValue } from './value.js';

/**
 * The trigger semantics from the sprint README: a trigger fires on a threshold
 * crossing or a content change against the last observation, and never fires
 * again on the same value. Dedup is a property of the comparison, not of the
 * notifier, so a job retried after a crash reaches the same answer.
 */

function price(amount: number, currency: string | null = 'USD'): PriceValue {
  return { kind: 'price', amount, currency, raw: `$${amount.toFixed(2)}` };
}

function digest(text: string): DigestValue {
  return { kind: 'digest', digest: `digest-of-${text}`, excerpt: text };
}

const BELOW_15: WatchCondition = { kind: 'price', drops_below: 15, rises_above: null };
const ABOVE_20: WatchCondition = { kind: 'price', drops_below: null, rises_above: 20 };
const BETWEEN: WatchCondition = { kind: 'price', drops_below: 15, rises_above: 20 };
const ANY_CHANGE: WatchCondition = { kind: 'change', region: null };

describe('priceSatisfies', () => {
  it('holds strictly below a drop threshold and strictly above a rise threshold', () => {
    expect(priceSatisfies(BELOW_15, price(14.99))).toBe(true);
    expect(priceSatisfies(BELOW_15, price(15))).toBe(false);
    expect(priceSatisfies(ABOVE_20, price(20.01))).toBe(true);
    expect(priceSatisfies(ABOVE_20, price(20))).toBe(false);
  });

  it('holds when either bound of a two-sided condition is crossed', () => {
    const outside: WatchCondition = { kind: 'price', drops_below: 10, rises_above: 20 };

    expect(priceSatisfies(outside, price(9))).toBe(true);
    expect(priceSatisfies(outside, price(21))).toBe(true);
    expect(priceSatisfies(outside, price(15))).toBe(false);
  });
});

describe('compare for a price watch', () => {
  it('triggers on the first observation that already meets the condition', () => {
    // "Tell me when this drops below $15" and it is $14.99 right now: the
    // person asked to be told, and there is no earlier reading to have told
    // them from.
    expect(compare(BELOW_15, null, price(14.99))).toEqual({
      triggered: true,
      reason: 'price 14.99 drops below 15',
    });
  });

  it('triggers on a crossing from above to below', () => {
    expect(compare(BELOW_15, price(16), price(14.99)).triggered).toBe(true);
  });

  it('does not fire again while the price stays on the far side of the threshold', () => {
    // 14.99 then 14.99 (the same value), then 14.50 (a different value that is
    // no new crossing): the README's "never re-firing on the same value" and
    // the spec's dedup against the last observation are both this.
    expect(compare(BELOW_15, price(14.99), price(14.99))).toEqual({
      triggered: false,
      reason: 'price 14.99 still drops below 15',
    });
    expect(compare(BELOW_15, price(14.99), price(14.5)).triggered).toBe(false);
  });

  it('re-arms once the price goes back over the threshold', () => {
    expect(compare(BELOW_15, price(14.99), price(16))).toEqual({
      triggered: false,
      reason: 'price 16 does not drop below 15',
    });
    expect(compare(BELOW_15, price(16), price(14.99)).triggered).toBe(true);
  });

  it('says which bound a price failed to cross, and both when there are two', () => {
    expect(compare(ABOVE_20, null, price(18))).toEqual({
      triggered: false,
      reason: 'price 18 does not rise above 20',
    });
    expect(compare(BETWEEN, null, price(17))).toEqual({
      triggered: false,
      reason: 'price 17 does not drop below 15 or rise above 20',
    });
    expect(compare(BETWEEN, null, price(21))).toEqual({
      triggered: true,
      reason: 'price 21 rises above 20',
    });
  });

  it('reports a swing from one bound of a two-sided condition to the other as a new crossing', () => {
    expect(compare(BETWEEN, price(14), price(21))).toEqual({
      triggered: true,
      reason: 'price 21 rises above 20',
    });
    expect(compare(BETWEEN, price(21), price(14))).toEqual({
      triggered: true,
      reason: 'price 14 drops below 15',
    });
  });

  it('stays quiet on the same side of a two-sided condition, naming the bound the price is still past', () => {
    expect(compare(BETWEEN, price(14), price(13))).toEqual({
      triggered: false,
      reason: 'price 13 still drops below 15',
    });
    expect(compare(BETWEEN, price(21), price(22))).toEqual({
      triggered: false,
      reason: 'price 22 still rises above 20',
    });
  });

  it('treats a rise threshold symmetrically', () => {
    expect(compare(ABOVE_20, price(19), price(21)).triggered).toBe(true);
    expect(compare(ABOVE_20, price(21), price(22)).triggered).toBe(false);
  });

  it('ignores a previous value of another kind rather than comparing across kinds', () => {
    // A watch whose kind changed under it has no meaningful last price.
    expect(compare(BELOW_15, digest('old'), price(14.99)).triggered).toBe(true);
  });

  it('never triggers on a value that is not a price', () => {
    expect(compare(BELOW_15, null, digest('text'))).toEqual({
      triggered: false,
      reason: 'the extracted value is a digest, not a price',
    });
  });
});

describe('compare for a change watch', () => {
  it('records the first observation as the baseline without triggering', () => {
    expect(compare(ANY_CHANGE, null, digest('a'))).toEqual({
      triggered: false,
      reason: 'baseline recorded',
    });
  });

  it('triggers when the digest differs from the last observation', () => {
    expect(compare(ANY_CHANGE, digest('a'), digest('b'))).toEqual({
      triggered: true,
      reason: 'content changed',
    });
  });

  it('does not trigger on an unchanged digest', () => {
    expect(compare(ANY_CHANGE, digest('a'), digest('a'))).toEqual({
      triggered: false,
      reason: 'content unchanged',
    });
  });

  it('starts a new baseline when the previous value was not a digest', () => {
    expect(compare(ANY_CHANGE, price(1), digest('a')).triggered).toBe(false);
  });

  it('never triggers on a value that is not a digest', () => {
    expect(compare(ANY_CHANGE, null, price(1))).toEqual({
      triggered: false,
      reason: 'the extracted value is a price, not a digest',
    });
  });
});

describe('triggerDedupKey', () => {
  it('is the same for the same watch, condition and value however they are spelled', () => {
    const one = triggerDedupKey('watch-1', BELOW_15, price(14.99));
    const same = triggerDedupKey(
      'watch-1',
      { rises_above: null, drops_below: 15, kind: 'price' },
      { raw: '14.99 USD', currency: 'USD', amount: 14.99, kind: 'price' },
    );

    expect(same).toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('differs by watch, by condition and by value', () => {
    const base = triggerDedupKey('watch-1', BELOW_15, price(14.99));

    expect(triggerDedupKey('watch-2', BELOW_15, price(14.99))).not.toBe(base);
    expect(triggerDedupKey('watch-1', ABOVE_20, price(14.99))).not.toBe(base);
    expect(triggerDedupKey('watch-1', BELOW_15, price(14.98))).not.toBe(base);
    expect(triggerDedupKey('watch-1', BELOW_15, price(14.99, 'EUR'))).not.toBe(base);
  });

  it('keys a digest value by its digest alone, not by the excerpt shown to people', () => {
    const a = triggerDedupKey('watch-1', ANY_CHANGE, { kind: 'digest', digest: 'x', excerpt: 'one' });
    const b = triggerDedupKey('watch-1', ANY_CHANGE, { kind: 'digest', digest: 'x', excerpt: 'two' });

    expect(a).toBe(b);
  });
});
