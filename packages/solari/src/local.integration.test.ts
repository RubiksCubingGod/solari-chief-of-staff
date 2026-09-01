import { describe, expect, it } from 'vitest';

import { createLocalProvider } from './local.js';
import { describeBrowserProviderContract } from './testing/contract.js';

describeBrowserProviderContract({
  name: 'LocalProvider',
  create: () => createLocalProvider(),
  // Plain Playwright applies none of the vendor capabilities. The contract
  // suite holds it to saying so rather than to providing them.
  applies: { stealth: false, proxy: false, captcha: false, recording: false },
});

describe('LocalProvider beyond the contract', () => {
  it('applies a configured timezone to the context and echoes the one in force', async () => {
    const provider = createLocalProvider({ timezoneId: 'Asia/Tokyo' });

    try {
      const session = await provider.acquire();
      const page = await session.newPage();

      expect(session.meta.timezoneId).toBe('Asia/Tokyo');
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
        'Asia/Tokyo',
      );

      await session.release();
    } finally {
      await provider.dispose();
    }
  });

  it('reports no timezone rather than guessing the host one', async () => {
    const provider = createLocalProvider();

    try {
      const session = await provider.acquire();

      expect(session.meta.timezoneId).toBeUndefined();

      await session.release();
    } finally {
      await provider.dispose();
    }
  });

  it('tracks concurrent sessions separately and releases each on its own', async () => {
    const provider = createLocalProvider();

    try {
      const first = await provider.acquire();
      const second = await provider.acquire();

      expect(first.meta.sessionId).not.toBe(second.meta.sessionId);
      expect(first.context).not.toBe(second.context);
      expect(provider.liveSessionIds()).toHaveLength(2);

      const page = await second.newPage();
      await first.release();

      expect(provider.liveSessionIds()).toEqual([second.meta.sessionId]);
      // The surviving session is still usable: releasing one must not close the
      // shared browser out from under the other.
      expect(second.context.pages()).toContain(page);
      await page.goto('about:blank');
    } finally {
      await provider.dispose();
    }
  });

  it('releases every live session when the provider is disposed', async () => {
    const provider = createLocalProvider();
    const session = await provider.acquire();

    await provider.dispose();

    expect(session.released).toBe(true);
    expect(provider.liveSessionIds()).toEqual([]);
  });
});
