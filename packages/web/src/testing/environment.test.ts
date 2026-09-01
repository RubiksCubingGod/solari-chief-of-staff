import { afterEach, describe, expect, it } from 'vitest';

import { withEnvironmentVariable } from './environment';

const NAME = 'CHIEF_OF_STAFF_WEB_ENVIRONMENT_PROBE';

afterEach(() => {
  delete process.env[NAME];
});

describe('withEnvironmentVariable', () => {
  it('removes a variable that was not there before', () => {
    const restore = withEnvironmentVariable(NAME, 'first');
    expect(process.env[NAME]).toBe('first');

    restore();

    expect(NAME in process.env).toBe(false);
  });

  it('puts back the value it displaced', () => {
    process.env[NAME] = 'original';
    const restore = withEnvironmentVariable(NAME, 'replacement');
    expect(process.env[NAME]).toBe('replacement');

    restore();

    expect(process.env[NAME]).toBe('original');
  });
});
