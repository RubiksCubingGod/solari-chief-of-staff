import { describe, expect, it } from 'vitest';

import { errorObservation, patchAfterObservation, successObservation } from './store.js';
import type { WatchValue } from './value.js';

const PRICE: WatchValue = { kind: 'price', amount: 14.99, currency: 'USD', raw: '$14.99' };
const NOW = new Date('2026-09-02T10:00:00.000Z');

describe('the observation constructors', () => {
  it('build a success with a value and no error', () => {
    expect(successObservation('http', PRICE, true)).toEqual({
      tierUsed: 'http',
      value: PRICE,
      triggered: true,
      error: null,
    });
  });

  it('build a failure with an error and no value, at whatever tier got that far', () => {
    expect(errorObservation('browser', 'timed out')).toEqual({
      tierUsed: 'browser',
      value: null,
      triggered: false,
      error: 'timed out',
    });
  });
});

describe('patchAfterObservation', () => {
  it('resets the failure counter and moves the last value on success', () => {
    expect(patchAfterObservation({ consecutiveFailures: 3 }, successObservation('http', PRICE, false), NOW)).toEqual({
      lastCheckedAt: NOW,
      lastError: null,
      lastValue: PRICE,
      consecutiveFailures: 0,
    });
  });

  it('counts a failure and records why, leaving the last value where it was', () => {
    const patch = patchAfterObservation({ consecutiveFailures: 3 }, errorObservation('http', 'timed out'), NOW);
    expect(patch).toEqual({ lastCheckedAt: NOW, lastError: 'timed out', consecutiveFailures: 4 });
    expect('lastValue' in patch).toBe(false);
  });
});
