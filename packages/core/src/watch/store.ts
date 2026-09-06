import type { FetchTier, WatchHealth, WatchKind, WatchStatus } from '../index.js';
import type { WatchValue } from './value.js';

/**
 * The persistence port of a check, and the pure arithmetic around it.
 *
 * What a check reads from a watch row and writes back to it is narrow enough
 * to name in full, and naming it in full is what lets the whole pipeline be
 * proved against an in-memory store while `packages/watch` binds the same
 * port to Drizzle. The column vocabulary (`tier_floor`, `health`,
 * `last_error`) is `packages/db`'s; the record here is its shape as a check
 * sees it, already parsed out of `jsonb`.
 */

export interface WatchRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: WatchKind;
  readonly url: string;
  /** As stored: `{}` until the model writes one. Parse with `parseExtractorSpec`. */
  readonly extractor: unknown;
  /** As stored. Parse with `parseCondition`. */
  readonly condition: unknown;
  readonly schedule: string;
  readonly tierPolicy: FetchTier | 'auto';
  readonly status: WatchStatus;
  readonly health: WatchHealth;
  /** The lowest tier worth trying: what the ladder learned last time. */
  readonly tierFloor: FetchTier;
  readonly lastValue: unknown;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
}

export interface ObservationRecord {
  readonly id: string;
  readonly watchId: string;
  readonly checkedAt: Date;
  readonly tierUsed: FetchTier;
  readonly value: WatchValue | null;
  readonly triggered: boolean;
  readonly error: string | null;
}

/**
 * What one check writes down about itself. Exactly one of `value` and
 * `error` is set. A check that failed before it fetched anything records
 * the tier it was going to fetch at - the watch's floor - because an
 * observation is about a check, and every check has a tier.
 */
export interface NewObservation {
  readonly tierUsed: FetchTier;
  readonly value: WatchValue | null;
  readonly triggered: boolean;
  readonly error: string | null;
}

/** The columns a check may change on its own row. Everything else is the API's. */
export interface WatchPatch {
  readonly extractor?: unknown;
  readonly health?: WatchHealth;
  readonly tierFloor?: FetchTier;
  readonly lastValue?: WatchValue | null;
  readonly lastCheckedAt?: Date;
  readonly lastError?: string | null;
  readonly consecutiveFailures?: number;
}

export interface WatchStore {
  loadWatch(id: string): Promise<WatchRecord | undefined>;
  updateWatch(id: string, patch: WatchPatch): Promise<void>;
  recordObservation(watchId: string, observation: NewObservation): Promise<ObservationRecord>;
  lastObservation(watchId: string): Promise<ObservationRecord | undefined>;
}

export function successObservation(
  tierUsed: FetchTier,
  value: WatchValue,
  triggered: boolean,
): NewObservation {
  return { tierUsed, value, triggered, error: null };
}

export function errorObservation(tierUsed: FetchTier, error: string): NewObservation {
  return { tierUsed, value: null, triggered: false, error };
}

/**
 * The row after an observation: the failure counter and the last error track
 * the most recent check, and the last value moves only when there was one.
 *
 * A failed check does not touch `last_value`: what the page last honestly
 * said stays what the next successful check is compared against, which is
 * what makes a trigger after an outage a trigger about the page and not
 * about the outage.
 */
export function patchAfterObservation(
  watch: Pick<WatchRecord, 'consecutiveFailures'>,
  observation: NewObservation,
  checkedAt: Date,
): WatchPatch {
  if (observation.error !== null) {
    return {
      lastCheckedAt: checkedAt,
      lastError: observation.error,
      consecutiveFailures: watch.consecutiveFailures + 1,
    };
  }
  return {
    lastCheckedAt: checkedAt,
    lastError: null,
    lastValue: observation.value,
    consecutiveFailures: 0,
  };
}
