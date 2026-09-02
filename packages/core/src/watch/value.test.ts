import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EXCERPT_LENGTH,
  WATCH_VALUE_KINDS,
  digestText,
  isWatchValue,
  normalizeText,
  parsePrice,
  sameValue,
  valueIdentity,
} from './value.js';

describe('parsePrice', () => {
  it.each([
    ['$19.99', 19.99, 'USD'],
    ['€1.299,00', 1299, 'EUR'],
    ['£1,299', 1299, 'GBP'],
    ['¥1,500', 1500, 'JPY'],
    ['USD 45', 45, 'USD'],
    ['45.00 EUR', 45, 'EUR'],
    ['1 299,50 kr', 1299.5, null],
    ['Now only 9.5!', 9.5, null],
    ['1,29', 1.29, null],
    ['12.345', 12345, null],
    ['12.345,67', 12345.67, null],
    ['12,345.67', 12345.67, null],
    ['7', 7, null],
  ])('reads %s as %d %s', (text, amount, currency) => {
    expect(parsePrice(text)).toEqual({ kind: 'price', amount, currency, raw: text });
  });

  it('keeps the raw text trimmed, so a wrong parse can be seen next to its source', () => {
    expect(parsePrice('  $19.99 \n')?.raw).toBe('$19.99');
  });

  it('refuses text with no number in it', () => {
    expect(parsePrice('Sold out')).toBeUndefined();
    expect(parsePrice('')).toBeUndefined();
  });

  it('prefers a currency code over a symbol when both appear', () => {
    expect(parsePrice('CAD $12.00')?.currency).toBe('CAD');
  });
});

describe('normalizeText and digestText', () => {
  it('treats whitespace as layout, not content', () => {
    expect(normalizeText('  a \n\t b   c ')).toBe('a b c');
    expect(digestText('Hello\n  world').digest).toBe(digestText('Hello world').digest);
  });

  it('digests with sha256 and keeps an excerpt for the person', () => {
    const value = digestText('Breaking: something happened');
    expect(value).toEqual({
      kind: 'digest',
      digest: createHash('sha256').update('Breaking: something happened').digest('hex'),
      excerpt: 'Breaking: something happened',
    });
  });

  it('cuts the excerpt at the limit and not the digest', () => {
    const long = 'x'.repeat(EXCERPT_LENGTH * 2);
    const value = digestText(long);
    expect(value.excerpt).toHaveLength(EXCERPT_LENGTH);
    expect(value.digest).toBe(createHash('sha256').update(long).digest('hex'));
  });
});

describe('isWatchValue', () => {
  it('lists the two kinds', () => {
    expect(WATCH_VALUE_KINDS).toEqual(['price', 'digest']);
  });

  it('accepts both shapes, with or without a currency', () => {
    expect(isWatchValue({ kind: 'price', amount: 1, currency: 'USD', raw: '$1' })).toBe(true);
    expect(isWatchValue({ kind: 'price', amount: 1, currency: null, raw: '1' })).toBe(true);
    expect(isWatchValue({ kind: 'digest', digest: 'abc', excerpt: '' })).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isWatchValue(null)).toBe(false);
    expect(isWatchValue('price')).toBe(false);
    expect(isWatchValue({ kind: 'slot' })).toBe(false);
    expect(isWatchValue({ kind: 'price', amount: '1', currency: null, raw: '1' })).toBe(false);
    expect(isWatchValue({ kind: 'price', amount: Number.NaN, currency: null, raw: '' })).toBe(false);
    expect(isWatchValue({ kind: 'price', amount: 1, currency: 3, raw: '1' })).toBe(false);
    expect(isWatchValue({ kind: 'price', amount: 1, currency: null })).toBe(false);
    expect(isWatchValue({ kind: 'digest', digest: 'abc' })).toBe(false);
    expect(isWatchValue({ kind: 'digest', digest: 1, excerpt: '' })).toBe(false);
  });
});

describe('sameValue', () => {
  it('compares prices by amount and currency, not by the text they came from', () => {
    expect(
      sameValue(
        { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
        { kind: 'price', amount: 14.99, currency: 'USD', raw: '14.99 USD' },
      ),
    ).toBe(true);
    expect(
      sameValue(
        { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' },
        { kind: 'price', amount: 14.99, currency: 'EUR', raw: '€14.99' },
      ),
    ).toBe(false);
  });

  it('compares digests by digest, not by excerpt', () => {
    expect(
      sameValue(
        { kind: 'digest', digest: 'd', excerpt: 'one' },
        { kind: 'digest', digest: 'd', excerpt: 'two' },
      ),
    ).toBe(true);
    expect(valueIdentity({ kind: 'digest', digest: 'd', excerpt: 'one' })).toEqual({ kind: 'digest', digest: 'd' });
  });

  it('never equates a price with a digest', () => {
    expect(
      sameValue(
        { kind: 'price', amount: 1, currency: null, raw: '1' },
        { kind: 'digest', digest: '1', excerpt: '1' },
      ),
    ).toBe(false);
  });
});
