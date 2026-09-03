import { describe, expect, it } from 'vitest';

import {
  ProfileStoreError,
  SOLARI_CONSOLE_URL,
  consoleProfilesUrl,
  createSolariProfileStore,
  type ProfileClient,
  type ProfileStore,
} from './profiles.js';

/**
 * The profile store: the one door the connect-site flow has into the vendor's
 * profiles. No live calls; the vendor client is injected, as it is for the
 * session provider next door.
 *
 * What is pinned here is the vendor's documented shape and its documented
 * refusals (`research/solari-sdk-surface.md`, profiles): a create over the
 * plan's cap is a 403 `PlanLimitExceeded`, a profile with the console editor
 * open answers 409 to a delete, and a delete of a profile that is already gone
 * is a success. The flow above this seam only ever sees the typed kinds, so a
 * vendor wording change breaks this file and nothing else.
 */

class FakeVendorError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(code === undefined ? `vendor answered ${String(status)}` : `${code} (${String(status)})`);
    this.name = 'SolariError';
    this.status = status;
    this.code = code;
  }
}

interface FakeVendor extends ProfileClient {
  readonly created: string[];
  readonly deleted: string[];
}

function fakeVendor(options: {
  readonly createError?: unknown;
  readonly deleteError?: Error;
  readonly existing?: { id: string; name: string; extra?: string }[];
} = {}): FakeVendor {
  const created: string[] = [];
  const deleted: string[] = [];
  let minted = 0;
  return {
    created,
    deleted,
    profiles: {
      create: ({ name }) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the vendor SDK is not ours and can reject with anything
        if (options.createError !== undefined) return Promise.reject(options.createError);
        created.push(name);
        minted += 1;
        return Promise.resolve({ id: `prof_${String(minted)}`, name });
      },
      list: () => Promise.resolve(options.existing ?? []),
      delete: (id) => {
        if (options.deleteError !== undefined) return Promise.reject(options.deleteError);
        deleted.push(id);
        return Promise.resolve();
      },
    },
  };
}

function storeOver(vendor: ProfileClient): ProfileStore {
  return createSolariProfileStore({ apiKey: 'test-key', client: vendor });
}

async function failure(work: Promise<unknown>): Promise<ProfileStoreError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProfileStoreError) return error;
    throw new Error(`expected a ProfileStoreError, got ${String(error)}`, { cause: error });
  }
  throw new Error('expected the call to fail');
}

describe('creating a profile', () => {
  it('hands the vendor the name and hands back the id the vendor minted', async () => {
    const vendor = fakeVendor();

    const profile = await storeOver(vendor).create('gym.example.test (1a2b3c4d)');

    expect(vendor.created).toEqual(['gym.example.test (1a2b3c4d)']);
    expect(profile).toEqual({ id: 'prof_1', name: 'gym.example.test (1a2b3c4d)' });
  });

  it('names the plan cap when the vendor refuses with PlanLimitExceeded', async () => {
    const vendor = fakeVendor({ createError: new FakeVendorError(403, 'PlanLimitExceeded') });

    const error = await failure(storeOver(vendor).create('one too many'));

    // The only route in the gateway that emits this code, and the one refusal
    // a person can act on: delete a profile in the console, or upgrade.
    expect(error.kind).toBe('plan-limit');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('PlanLimitExceeded');
  });

  it('marks a gateway outage as something worth trying again', async () => {
    const vendor = fakeVendor({ createError: new FakeVendorError(503) });

    const error = await failure(storeOver(vendor).create('later'));

    expect(error.kind).toBe('transport');
    expect(error.retryable).toBe(true);
  });

  it('marks a refused key as configuration, not as something to retry', async () => {
    const vendor = fakeVendor({ createError: new FakeVendorError(401, 'Unauthorized') });

    const error = await failure(storeOver(vendor).create('nobody'));

    expect(error.kind).toBe('configuration');
    expect(error.retryable).toBe(false);
  });

  it('keeps the vendor error as the cause, so an operator can read the whole thing', async () => {
    const cause = new FakeVendorError(500);
    const vendor = fakeVendor({ createError: cause });

    const error = await failure(storeOver(vendor).create('broken'));

    expect(error.kind).toBe('internal');
    expect(error.cause).toBe(cause);
  });

  it('quotes a refusal that is not an Error, since whatever the vendor threw is still the reason', async () => {
    const vendor = fakeVendor({ createError: 'the socket closed' });
    const error = await failure(storeOver(vendor).create('cut off'));
    expect(error.kind).toBe('internal');
    expect(error.message).toContain('the socket closed');
    expect(error.cause).toBe('the socket closed');
  });
});

describe('deleting a profile', () => {
  it('asks the vendor to delete exactly that id', async () => {
    const vendor = fakeVendor();

    await storeOver(vendor).delete('prof_9');

    expect(vendor.deleted).toEqual(['prof_9']);
  });

  it('treats a profile that is already gone as deleted', async () => {
    // The SDK swallows the 404 itself; this pins that the seam does too, so a
    // gateway that stops swallowing it cannot turn hygiene into a crash.
    const vendor = fakeVendor({ deleteError: new FakeVendorError(404, 'NotFound') });

    await expect(storeOver(vendor).delete('prof_gone')).resolves.toBeUndefined();
  });

  it('reports a profile the console editor still has open as a conflict', async () => {
    const vendor = fakeVendor({ deleteError: new FakeVendorError(409, 'Conflict') });

    const error = await failure(storeOver(vendor).delete('prof_open'));

    // Retryable: the person closes the editor tab and the delete goes through.
    expect(error.kind).toBe('conflict');
    expect(error.retryable).toBe(true);
  });
});

describe('listing profiles', () => {
  it('returns only the id and the name of each, whatever else the vendor sends', async () => {
    const vendor = fakeVendor({
      existing: [
        { id: 'prof_1', name: 'first', extra: 'ignored' },
        { id: 'prof_2', name: 'second' },
      ],
    });

    await expect(storeOver(vendor).list()).resolves.toEqual([
      { id: 'prof_1', name: 'first' },
      { id: 'prof_2', name: 'second' },
    ]);
  });
});

describe('the console editor link', () => {
  it('points at the profiles page of the vendor console by default', () => {
    // The only documented way for a person to log into a profile is the
    // console's own editor: Profiles, then Open editor. No API mints a link to
    // it, so the flow sends the person to the list and names the profile.
    expect(consoleProfilesUrl()).toBe(`${SOLARI_CONSOLE_URL}/profiles`);
    expect(SOLARI_CONSOLE_URL).toBe('https://console.getsolari.com');
  });

  it('accepts another console origin, with or without a trailing slash', () => {
    expect(consoleProfilesUrl('https://console.example.test/')).toBe(
      'https://console.example.test/profiles',
    );
    expect(consoleProfilesUrl('https://console.example.test')).toBe(
      'https://console.example.test/profiles',
    );
  });
});

describe('building the store', () => {
  it('refuses to build without an API key, in a sentence that names the variable', () => {
    expect(() => createSolariProfileStore({ apiKey: '' })).toThrow(/SOLARI_API_KEY/u);
  });

  it('builds over the vendor client without calling it', () => {
    // No network here: the vendor client is constructed lazily and nothing on
    // it is invoked until a profile is asked for.
    const store = createSolariProfileStore({ apiKey: 'key', baseUrl: 'http://127.0.0.1:9' });

    expect(typeof store.create).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.list).toBe('function');
  });
});
