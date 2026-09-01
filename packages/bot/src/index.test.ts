import { describe, expect, it } from 'vitest';

import { MODULE_ID } from './index.js';

describe('@chief-of-staff/bot', () => {
  it('exposes its module id through the package entry point', () => {
    expect(MODULE_ID).toBe('@chief-of-staff/bot');
  });
});
