import { describe, expect, it, vi } from 'vitest';

import { createLocalProvider } from './local.js';
import { BrowserProviderError } from './provider.js';

/**
 * The acquire-failure path, with the launcher injected. It has to leave no
 * tracked session behind, and the missing-browser case has to say what to run:
 * the browser binaries are not installed by `pnpm install`, so this is the
 * first error a stranger to the repository meets.
 */
describe('createLocalProvider acquire failures', () => {
  it('names the command that installs the browser when Chromium is missing', async () => {
    const launch = vi.fn(() =>
      Promise.reject(
        new Error(
          "browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium-1234\\chrome.exe",
        ),
      ),
    );
    const provider = createLocalProvider({ launch });

    const error = await provider.acquire().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserProviderError);
    expect((error as BrowserProviderError).kind).toBe('unavailable');
    expect((error as BrowserProviderError).retryable).toBe(false);
    expect((error as Error).message).toContain('pnpm browsers');
    expect(provider.liveSessionIds()).toEqual([]);
  });

  it('reports any other launch failure as internal, keeping the original error', async () => {
    const cause = new Error('the sandbox refused to fork');
    const provider = createLocalProvider({ launch: () => Promise.reject(cause) });

    const error = await provider.acquire().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BrowserProviderError);
    expect((error as BrowserProviderError).kind).toBe('internal');
    expect((error as BrowserProviderError).provider).toBe('local');
    expect((error as Error).cause).toBe(cause);
    expect(provider.liveSessionIds()).toEqual([]);
  });

  it('retries the launch on the next acquire rather than caching the failure', async () => {
    const launch = vi.fn(() => Promise.reject(new Error('transient')));
    const provider = createLocalProvider({ launch });

    await expect(provider.acquire()).rejects.toBeInstanceOf(BrowserProviderError);
    await expect(provider.acquire()).rejects.toBeInstanceOf(BrowserProviderError);

    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('disposes cleanly when no browser was ever launched', async () => {
    const launch = vi.fn(() => Promise.reject(new Error('never called')));
    const provider = createLocalProvider({ launch });

    await expect(provider.dispose()).resolves.toBeUndefined();

    expect(launch).not.toHaveBeenCalled();
    expect(provider.liveSessionIds()).toEqual([]);
  });
});
