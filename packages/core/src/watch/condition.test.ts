import { describe, expect, it } from 'vitest';

import { describeCondition, parseApplicant, parseCondition } from './condition.js';

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
  it('reads the site, the applicant and whether to book without asking', () => {
    expect(parseCondition('slot', { site: 'fakedmv', applicant: { name: 'Ada Lovelace' }, auto_book: true })).toEqual({
      kind: 'slot',
      site: 'fakedmv',
      applicant: { name: 'Ada Lovelace' },
      auto_book: true,
    });
  });

  it('defaults to asking first, and trims what the person typed', () => {
    expect(parseCondition('slot', { site: ' fakedmv ', applicant: { name: ' Ada ' } })).toEqual({
      kind: 'slot',
      site: 'fakedmv',
      applicant: { name: 'Ada' },
      auto_book: false,
    });
  });

  it.each([
    ['nothing', {}],
    ['no applicant', { site: 'fakedmv' }],
    ['a blank site', { site: ' ', applicant: { name: 'Ada' } }],
    ['a non-string site', { site: 3, applicant: { name: 'Ada' } }],
    ['an applicant with no name', { site: 'fakedmv', applicant: {} }],
    ['an applicant with a blank name', { site: 'fakedmv', applicant: { name: '' } }],
    ['an applicant that is not an object', { site: 'fakedmv', applicant: 'Ada' }],
    ['an applicant with extra fields', { site: 'fakedmv', applicant: { name: 'Ada', email: 'ada@example.test' } }],
    ['a non-boolean auto_book', { site: 'fakedmv', applicant: { name: 'Ada' }, auto_book: 'yes' }],
    ['an unknown key', { site: 'fakedmv', applicant: { name: 'Ada' }, drops_below: 15 }],
    ['a non-object', 'fakedmv'],
  ])('refuses %s', (_label, value) => {
    expect(parseCondition('slot', value)).toBeUndefined();
  });

  it('exposes the applicant parser for the door and the task input to share', () => {
    expect(parseApplicant({ name: 'Ada' })).toEqual({ name: 'Ada' });
    expect(parseApplicant(null)).toBeUndefined();
    expect(parseApplicant([])).toBeUndefined();
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

  it('says where a slot condition waits for an appointment', () => {
    expect(
      describeCondition({ kind: 'slot', site: 'fakedmv', applicant: { name: 'Ada' }, auto_book: false }),
    ).toBe('an appointment slot appears on fakedmv');
  });
});
