import { describe, expect, it } from 'vitest';

import * as db from './index.js';

describe('@chief-of-staff/db', () => {
  it('exposes the shared client factory through the package entry point', () => {
    expect(Object.keys(db)).toEqual(['createDatabase']);
    expect(typeof db.createDatabase).toBe('function');
  });
});
