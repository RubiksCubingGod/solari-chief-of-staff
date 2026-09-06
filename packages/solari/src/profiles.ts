import { createSolariClient, readVendorFailure, type SolariClientOptions } from './solari.js';

/**
 * The vendor's browser profiles, behind a seam the connect-site flow can hold.
 *
 * A profile is a saved logged-in state the worker attaches to a session by id.
 * The only documented way for a person to *put* a login into one is the
 * vendor console's profile editor - Profiles, then Open editor - which drives
 * a live browser in a console tab and saves on the way out. No API mints a
 * link to that editor or to a live view of a session; the research behind the
 * substrate sprint went looking and found the observer stream both unminted
 * and read-only. So the flow above this seam sends the person to the console's
 * profile list with the name to look for, and keeps only the id afterwards.
 *
 * What this module owns is the vendor's documented edges around that: the
 * plan's cap on profile count, the 409 a profile with the editor open answers
 * to a delete, and a delete of a profile that is already gone being a success.
 * Everything above it sees the typed kinds and nothing of the vendor's words.
 */

/** Where the console lives. Overridable for a self-hosted gateway, or a test. */
export const SOLARI_CONSOLE_URL = 'https://console.getsolari.com';

/** The console's profile list, where "Open editor" is. */
export function consoleProfilesUrl(consoleUrl: string = SOLARI_CONSOLE_URL): string {
  return `${consoleUrl.replace(/\/+$/u, '')}/profiles`;
}

export interface BrowserProfile {
  readonly id: string;
  readonly name: string;
}

/**
 * The slice of the vendor client's `profiles` this seam drives, spelled out
 * structurally so a unit test can hand over its own and so this file names no
 * vendor type - `solari.ts` is the one module allowed to.
 */
export interface VendorProfiles {
  create(input: { readonly name: string }): Promise<{ readonly id: string; readonly name: string }>;
  list(): Promise<readonly { readonly id: string; readonly name: string }[]>;
  delete(id: string): Promise<unknown>;
}

export interface ProfileClient {
  readonly profiles: VendorProfiles;
}

export interface ProfileStore {
  /** Mints an empty profile under that name. The person fills it in the console. */
  create(name: string): Promise<BrowserProfile>;
  /** Removes a profile. One that is already gone counts as removed. */
  delete(id: string): Promise<void>;
  list(): Promise<readonly BrowserProfile[]>;
}

export type ProfileStoreErrorKind =
  /** The plan's cap on profiles. A person frees one in the console, or upgrades. */
  | 'plan-limit'
  /** The console editor still has the profile open. Closing the tab clears it. */
  | 'conflict'
  /** The key was refused, or is missing. Nothing but configuration fixes it. */
  | 'configuration'
  /** The gateway did not answer, or answered that it could not. Try again later. */
  | 'transport'
  | 'internal';

export interface ProfileStoreErrorOptions {
  readonly kind: ProfileStoreErrorKind;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class ProfileStoreError extends Error {
  readonly kind: ProfileStoreErrorKind;
  readonly retryable: boolean;

  constructor(message: string, options: ProfileStoreErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProfileStoreError';
    this.kind = options.kind;
    this.retryable = options.retryable;
  }
}

export interface ProfileStoreOptions extends SolariClientOptions {
  /** The vendor client to drive; built from the key when absent. */
  readonly client?: ProfileClient;
}

/**
 * Classifies a vendor failure by the status and code the gateway documents.
 * `PlanLimitExceeded` is the one code that matters by name: it is the only
 * route in the gateway that emits it, and the one refusal a person can act on.
 */
function describeProfileFailure(error: unknown, doing: string): ProfileStoreError {
  const { status, code } = readVendorFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail = code === undefined ? message : `${code}: ${message}`;
  const options = ((): ProfileStoreErrorOptions => {
    if (status === 403 && code === 'PlanLimitExceeded') {
      return { kind: 'plan-limit', retryable: false, cause: error };
    }
    if (status === 409) return { kind: 'conflict', retryable: true, cause: error };
    if (status === 401 || status === 403) {
      return { kind: 'configuration', retryable: false, cause: error };
    }
    if (status === 502 || status === 503 || status === 504) {
      return { kind: 'transport', retryable: true, cause: error };
    }
    return { kind: 'internal', retryable: false, cause: error };
  })();
  return new ProfileStoreError(`solari ${doing} failed (${detail})`, options);
}

export function createSolariProfileStore(options: ProfileStoreOptions): ProfileStore {
  if (options.apiKey === '') {
    throw new ProfileStoreError(
      'the profile store needs an API key: pass `apiKey` or set SOLARI_API_KEY',
      { kind: 'configuration', retryable: false },
    );
  }
  // Built once, lazily: constructing the vendor client opens no connection,
  // but a store nobody asks anything of should still cost nothing. The
  // store's options are the client's plus `client`, so they pass as they are.
  let vendor: ProfileClient | undefined = options.client;
  const client = (): ProfileClient => {
    vendor ??= createSolariClient(options);
    return vendor;
  };

  return {
    async create(name) {
      try {
        const profile = await client().profiles.create({ name });
        return { id: profile.id, name: profile.name };
      } catch (error) {
        throw describeProfileFailure(error, 'profile create');
      }
    },
    async delete(id) {
      try {
        await client().profiles.delete(id);
      } catch (error) {
        // The SDK swallows a 404 itself; this is the same decision made here,
        // so a gateway that stops swallowing it cannot turn hygiene into a
        // crash. A profile that is not there is a profile that is deleted.
        if (readVendorFailure(error).status === 404) return;
        throw describeProfileFailure(error, 'profile delete');
      }
    },
    async list() {
      try {
        const profiles = await client().profiles.list();
        return profiles.map(({ id, name }) => ({ id, name }));
      } catch (error) {
        throw describeProfileFailure(error, 'profile list');
      }
    },
  };
}
