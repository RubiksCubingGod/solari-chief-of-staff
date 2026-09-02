import { describe, expect, it } from 'vitest';

import { describeCondition, parseCondition } from './condition.js';

describe('parseCondition for a price watch', () => {
  it('accepts either threshold or both, defaulting the other to null', () => {
    expect(parseCondition('price', { drops_below: 15 })).toEqual({
      kind: 'price',
      drops_below: 15,
      rises_above: null,
    });
    expect(parseCondition('price', { rises_above: 20 })).toEqual({
      kind: 'price',
      drops_below: null,
      rises_above: 20,
    });
    expect(parseCondition('price', { drops_below: 15, rises_above: 20 })).toEqual({
      kind: 'price',
      drops_below: 15,
      rises_above: 20,
    });
  });

  it('accepts an explicit null threshold', () => {
    expect(parseCondition('price', { drops_below: 15, rises_above: null })).toEqual({
      kind: 'price',
      drops_below: 15,
      rises_above: null,
    });
  });

  it.each([
    ['nothing', {}],
    ['both null', { drops_below: null, rises_above: null }],
    ['a string threshold', { drops_below: '15' }],
    ['an infinite threshold', { drops_below: Number.POSITIVE_INFINITY }],
    ['an unknown key', { drops_below: 15, region: 'the price' }],
    ['a non-object', 15],
    ['an array', [15]],
  ])('refuses %s', (_label, value) => {
    expect(parseCondition('price', value)).toBeUndefined();
  });
});

describe('parseCondition for a change watch', () => {
  it('accepts an empty condition as the whole page', () => {
    expect(parseCondition('change', {})).toEqual({ kind: 'change', region: null });
    expect(parseCondition('change', { region: null })).toEqual({ kind: 'change', region: null });
  });

  it('keeps the region in the words the person used', () => {
    expect(parseCondition('change', { region: 'the headline' })).toEqual({
      kind: 'change',
      region: 'the headline',
    });
  });

  it.each([
    ['a blank region', { region: '' }],
    ['a non-string region', { region: 3 }],
    ['a price key', { drops_below: 15 }],
  ])('refuses %s', (_label, value) => {
    expect(parseCondition('change', value)).toBeUndefined();
  });
});

describe('parseCondition for a slot watch', () => {
  it('is not this sprint', () => {
    expect(parseCondition('slot', {})).toBeUndefined();
  });
});

describe('describeCondition', () => {
  it('says what a price condition waits for', () => {
    expect(describeCondition({ kind: 'price', drops_below: 15, rises_above: null })).toBe(
      'the price drops below 15',
    );
    expect(describeCondition({ kind: 'price', drops_below: null, rises_above: 20 })).toBe(
      'the price rises above 20',
    );
    expect(describeCondition({ kind: 'price', drops_below: 15, rises_above: 20 })).toBe(
      'the price drops below 15 or rises above 20',
    );
  });

  it('says what a change condition watches', () => {
    expect(describeCondition({ kind: 'change', region: null })).toBe('the page changes');
    expect(describeCondition({ kind: 'change', region: 'the headline' })).toBe('the headline changes');
  });
});
