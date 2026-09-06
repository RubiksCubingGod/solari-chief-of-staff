import { describe, expect, it } from 'vitest';

import * as solari from './index.js';

/**
 * The seam is what other packages are allowed to know about. This holds the
 * entry point to exporting it - and to keeping the vendor behind it, since a
 * leaked SDK type here is how "no engine imports the vendor" quietly stops
 * being true.
 */
describe('@chief-of-staff/solari', () => {
  it('exports the seam: a way to get a provider, and the way to use one', () => {
    expect(typeof solari.createLocalProvider).toBe('function');
    expect(typeof solari.withBrowser).toBe('function');
    expect(typeof solari.reportReleaseFailureToConsole).toBe('function');
    expect(solari.BrowserProviderError.prototype).toBeInstanceOf(Error);
  });

  it('exports nothing else at runtime, so the surface stays the reviewed one', () => {
    expect(Object.keys(solari).sort()).toEqual([
      'BrowserProviderError',
      'PROXY_COUNTRIES',
      'ProfileStoreError',
      'SOLARI_CONSOLE_URL',
      'STICKY_DURATION_MINUTES',
      'consoleProfilesUrl',
      'createLocalProvider',
      'createSolariProfileStore',
      'createSolariProvider',
      'reportReleaseFailureToConsole',
      'withBrowser',
    ]);
  });
});
