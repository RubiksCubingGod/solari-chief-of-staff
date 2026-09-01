import { describe, expect, it } from 'vitest';

import { API_BASE_URL_VARIABLE, createApiClient, loadWebConfig } from './index';

/**
 * The package entry point, exercised rather than trusted: importing it proves
 * the workspace link and the module graph the pages rely on both resolve, so a
 * broken toolchain fails here instead of surfacing later as a page that will
 * not compile.
 */
describe('@chief-of-staff/web', () => {
  it('exposes the configuration and the client the pages are built from', () => {
    const config = loadWebConfig({ [API_BASE_URL_VARIABLE]: 'http://127.0.0.1:3000' });

    expect(config.apiBaseUrl).toBe('http://127.0.0.1:3000');
    expect(createApiClient({ baseUrl: config.apiBaseUrl })).toHaveProperty('listWatches');
  });
});
