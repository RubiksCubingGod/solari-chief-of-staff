import { describe, expect, it } from 'vitest';

import {
  AJV_FORMATS,
  MAX_OBSERVATION_LIMIT,
  isCronExpression,
  isHttpUrl,
  isIsoDate,
  isIsoInstant,
  isObservationLimit,
  isUuid,
} from './formats.js';

describe('isUuid', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects anything that only looks like one', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c330')).toBe(false);
    expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('isHttpUrl', () => {
  it('accepts the two schemes the fetch tiers can speak', () => {
    expect(isHttpUrl('https://shop.test/item/1?size=9')).toBe(true);
    expect(isHttpUrl('http://shop.test')).toBe(true);
  });

  it('rejects a scheme no tier could fetch and a string that is not a url', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('shop.test/item/1')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('isCronExpression', () => {
  it('accepts the expressions a watch schedule is written in', () => {
    expect(isCronExpression('0 * * * *')).toBe(true);
    expect(isCronExpression('*/15 9-17 * * 1-5')).toBe(true);
  });

  it('rejects prose and an out-of-range field', () => {
    expect(isCronExpression('every other friday')).toBe(false);
    expect(isCronExpression('0 99 * * *')).toBe(false);
    expect(isCronExpression('')).toBe(false);
  });
});

describe('isIsoDate', () => {
  it('accepts a plain calendar date', () => {
    expect(isIsoDate('2026-10-12')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects a date that does not exist and one that carries a time', () => {
    // Rolling over to 2026-03-01 would be a silently wrong renewal date.
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-10-12T00:00:00Z')).toBe(false);
    expect(isIsoDate('12/10/2026')).toBe(false);
  });
});

describe('isIsoInstant', () => {
  it('accepts an instant with a zone, at second and millisecond precision', () => {
    expect(isIsoInstant('2026-08-02T00:00:00Z')).toBe(true);
    expect(isIsoInstant('2026-08-02T00:00:00.000Z')).toBe(true);
    expect(isIsoInstant('2026-08-02T02:00:00+02:00')).toBe(true);
  });

  it('rejects an instant with no zone, a calendar day, and a date that does not exist', () => {
    // Without a zone the bound would mean a different moment to every caller.
    expect(isIsoInstant('2026-08-02T00:00:00')).toBe(false);
    expect(isIsoInstant('2026-08-02')).toBe(false);
    expect(isIsoInstant('2026-02-30T00:00:00Z')).toBe(false);
    expect(isIsoInstant('2026-08-02T24:00:00Z')).toBe(false);
    expect(isIsoInstant('2026-08-02T00:00:00+25:00')).toBe(false);
    expect(isIsoInstant('yesterday')).toBe(false);
    expect(isIsoInstant('')).toBe(false);
  });
});

describe('isObservationLimit', () => {
  it('accepts a plain count up to the ceiling', () => {
    expect(isObservationLimit('1')).toBe(true);
    expect(isObservationLimit('250')).toBe(true);
    expect(isObservationLimit(String(MAX_OBSERVATION_LIMIT))).toBe(true);
  });

  it('rejects a count past the ceiling and anything that is not one', () => {
    expect(isObservationLimit(String(MAX_OBSERVATION_LIMIT + 1))).toBe(false);
    expect(isObservationLimit('0')).toBe(false);
    expect(isObservationLimit('-1')).toBe(false);
    // A leading zero, a decimal point and an exponent all reach `Number` as
    // something other than the count they look like, so none of them get there.
    expect(isObservationLimit('007')).toBe(false);
    expect(isObservationLimit('2.5')).toBe(false);
    expect(isObservationLimit('1e2')).toBe(false);
    expect(isObservationLimit('abc')).toBe(false);
    expect(isObservationLimit('')).toBe(false);
  });
});

describe('AJV_FORMATS', () => {
  it('names every format the route schemas reference', () => {
    expect(Object.keys(AJV_FORMATS).sort()).toEqual([
      'cron-expression',
      'http-url',
      'iso-date',
      'iso-instant',
      'observation-limit',
      'uuid',
    ]);
  });
});
