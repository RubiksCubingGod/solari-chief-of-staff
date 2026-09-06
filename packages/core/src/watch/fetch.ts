import type { FetchTier } from '../index.js';

/**
 * What one attempt at fetching a page comes back with, whichever tier made it.
 *
 * Tier 0 is a plain HTTP GET (`packages/watch/src/fetch/http.ts`); tiers 1 and
 * 2 drive a browser through the provider seam. All three answer in this shape
 * so the ladder above them can read a verdict off the content without caring
 * which tier produced it, and so an observation can record honestly what was
 * tried.
 *
 * A non-2xx status is not an error here. A 403 is what a block looks like and
 * a 404 is what a vanished page looks like; both are content for the
 * classifier, and the classifier is the ladder's, not the fetcher's.
 */

export const FETCH_ERROR_KINDS = ['timeout', 'network', 'provider'] as const;
export type FetchErrorKind = (typeof FETCH_ERROR_KINDS)[number];

export interface FetchMeta {
  readonly tier: FetchTier;
  /** What was asked for. */
  readonly url: string;
  /** Where the response actually came from, after redirects. */
  readonly finalUrl: string;
  readonly status: number;
  readonly redirected: boolean;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly elapsedMs: number;
  /** Whether the tier asked for stealth - and, for tier 2, got it (the seam echoes it). */
  readonly stealth: boolean;
}

export interface FetchError {
  readonly kind: FetchErrorKind;
  readonly message: string;
}

export type FetchAttempt =
  | { readonly ok: true; readonly tier: FetchTier; readonly html: string; readonly meta: FetchMeta }
  | {
      readonly ok: false;
      readonly tier: FetchTier;
      readonly error: FetchError;
      readonly elapsedMs: number;
    };

export function describeFetchError(error: FetchError): string {
  return `${error.kind}: ${error.message}`;
}
