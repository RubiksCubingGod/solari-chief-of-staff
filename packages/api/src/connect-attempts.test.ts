import type { BrowserProfile, ProfileStore } from '@chief-of-staff/solari';
import { describe, expect, it } from 'vitest';

import { createConnectAttemptLedger } from './connect-attempts.js';

/**
 * Two corners of the ledger the route proofs do not reach: what it does when
 * the vendor will not take a profile back and nobody asked to hear about it,
 * and what it says about an attempt nobody opened. Everything else about it
 * is proven from the routes inward.
 */

interface StoreThat extends ProfileStore {
  readonly deleted: string[];
}

function storeThat(options: { readonly deleteError?: Error } = {}): StoreThat {
  const deleted: string[] = [];
  let minted = 0;
  return {
    deleted,
    create: (name) => {
      minted += 1;
      const profile: BrowserProfile = { id: `prof_${String(minted)}`, name };
      return Promise.resolve(profile);
    },
    delete: (id) => {
      deleted.push(id);
      return options.deleteError === undefined ? Promise.resolve() : Promise.reject(options.deleteError);
    },
    list: () => Promise.resolve([]),
  };
}

describe('createConnectAttemptLedger', () => {
  it('has nothing to cancel for an attempt nobody opened, and says so', async () => {
    const ledger = createConnectAttemptLedger({ store: storeThat(), timeoutMs: 60_000 });

    await expect(ledger.cancel('user-1', 'nobody-opened-this')).resolves.toBe(false);

    await ledger.close();
  });

  it('closes the attempt even when the vendor keeps the profile, and keeps quiet unless asked to warn', async () => {
    const store = storeThat({ deleteError: new Error('the gateway is away') });
    const ledger = createConnectAttemptLedger({ store, timeoutMs: 60_000 });
    const attempt = await ledger.start('user-1', 'gym.example.test');

    await expect(ledger.cancel('user-1', attempt.id)).resolves.toBe(true);

    expect(store.deleted).toEqual([attempt.profile.id]);
    expect(ledger.read('user-1', attempt.id)?.status).toBe('cancelled');
    await ledger.close();
  });
});
