import { describe, expect, it } from 'vitest';

import { FETCH_ERROR_KINDS, describeFetchError } from './fetch.js';

describe('the fetch vocabulary', () => {
  it('names the three ways a fetch fails without answering', () => {
    expect(FETCH_ERROR_KINDS).toEqual(['timeout', 'network', 'provider']);
  });

  it('describes an error as its kind and its words', () => {
    expect(describeFetchError({ kind: 'timeout', message: 'no response in 15000ms' })).toBe(
      'timeout: no response in 15000ms',
    );
  });
});
