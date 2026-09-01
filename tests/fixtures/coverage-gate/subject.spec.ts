import { expect, it } from 'vitest';

import { describeSign } from './subject.js';

// Deliberately incomplete: the negative branch is never taken.
it('describes a positive number', () => {
  expect(describeSign(1)).toBe('not negative');
});
